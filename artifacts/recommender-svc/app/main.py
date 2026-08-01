import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from app.auth import require_internal_key
from app.cache_repo import search_cache
from app.config import settings
from app.db import close_pool, get_pool
from app.embed_upsert import upsert_cache_docs
from app.embeddings import embed
from app.farm_context import format_farm_context, get_farm_context
from app.ingest import run_tavily_ingest
from app.models import RecommendRequest, RecommendResponse, Source
from app.query_log import log_query
from app.synthesis import synthesize_answer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await get_pool()  # warm the connection pool on startup
    yield
    await close_pool()


app = FastAPI(title="FarmSmart Recommender", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/recommend", response_model=RecommendResponse, dependencies=[Depends(require_internal_key)])
async def recommend(req: RecommendRequest) -> RecommendResponse:
    """
    Embeds the question, vector-searches recommender_cache. On a miss, runs
    a live Tavily search (via dlt), embeds + upserts the new docs into
    recommender_cache, and re-searches. Matches crop/seed names mentioned in
    the question against the farm's own growth_profiles/bad_tray_entries for
    grounding context, and combines that with api-server's ops_context (a
    dashboard snapshot, attached when the question is about the farm's own
    live numbers rather than crop agronomy — this service's crop/seed
    matching alone can't answer "what's my yield this week"). Synthesizes a
    cited answer via Gemini, combining the external docs and grounding
    context — falls back to the raw top-match answer (R2 behavior) if
    synthesis fails or there's nothing to synthesize from. Every Q&A is
    logged to recommender_queries for audit / a future "recent questions"
    UI.
    """
    question_embedding = await embed(req.question)
    hits = await search_cache(question_embedding, limit=5)
    used_live_search = False

    if not hits and settings.tavily_api_key:
        docs = await asyncio.to_thread(run_tavily_ingest, req.question)
        await upsert_cache_docs(docs)
        hits = await search_cache(question_embedding, limit=5)
        used_live_search = True

    farm_context = await get_farm_context(req.question)
    farm_context_text = format_farm_context(farm_context) if farm_context else None
    grounding_text = "\n\n".join(t for t in (farm_context_text, req.ops_context) if t) or None

    if not hits and not grounding_text:
        message = (
            "No relevant results found, even after a live search."
            if used_live_search
            else "No cached knowledge matches this question yet, and live search isn't configured."
        )
        await log_query(req.user_id, req.question, message, [], farm_context)
        return RecommendResponse(answer=message, sources=[], cache_hit=False)

    sources = [
        Source(title=h["title"], url=h["source_url"], similarity=round(h["similarity"], 3))
        for h in hits
    ]

    synthesized = await synthesize_answer(req.question, hits, grounding_text) if hits or grounding_text else None

    if synthesized is not None:
        answer = synthesized
    elif hits:
        top = hits[0]
        prefix = "Found via live search: " if used_live_search else "Closest cached match: "
        answer = f"{prefix}{top['title'] or top['source_url']}\n\n{top['content'][:500]}"
    else:
        answer = f"Farm data: {grounding_text}"

    logged_context: dict | None = dict(farm_context) if farm_context else None
    if req.ops_context:
        logged_context = {**(logged_context or {}), "ops_context": req.ops_context}

    await log_query(req.user_id, req.question, answer, [s.model_dump() for s in sources], logged_context)
    return RecommendResponse(answer=answer, sources=sources, cache_hit=not used_live_search)
