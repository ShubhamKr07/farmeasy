import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException

from app.auth import require_internal_key
from app.cache_repo import search_cache
from app.config import settings
from app.db import close_pool, get_pool
from app.embed_upsert import upsert_cache_docs
from app.tls import cleanup_ca_cert_file, write_ca_cert_file
from app.embeddings import embed
from app.farm_context import format_farm_context, get_farm_context
from app.ingest import run_tavily_ingest
from app.models import RecommendRequest, RecommendResponse, Source
from app.query_log import log_query
from app.synthesis import synthesize_answer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await get_pool()  # warm the connection pool on startup
    # Materialize the CA cert to /tmp for dlt/psycopg2's sslrootcert= (Task
    # 10) — asyncpg uses the SSLContext in-memory, but psycopg2 needs a file
    # path. Written once here at startup; removed at shutdown below.
    write_ca_cert_file()
    yield
    await close_pool()
    cleanup_ca_cert_file()


app = FastAPI(title="FarmSmart Recommender", lifespan=lifespan)

# Process-wide capacity gate (Task 9 / Step 7). A single ASGI worker must
# bound concurrent /recommend processing, so this semaphore is created ONCE
# at import and shared by every request on the event loop. A bounded acquire
# (see recommend below) fails fast with 503 when saturated instead of
# letting callers queue indefinitely. asyncio.Semaphore lazily binds to the
# running loop on first use, so module-level construction is safe here.
_request_semaphore = asyncio.Semaphore(settings.recommender_max_concurrent_requests)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


async def _process_recommend(req: RecommendRequest) -> RecommendResponse:
    """
    Full recommendation-processing body: embed the question, vector-search
    recommender_cache, optionally live-search via Tavily on a miss, gather
    farm/ops grounding context, synthesize a cited answer via Gemini, and
    log the query. Separated from recommend() so the concurrency/deadline
    bounding in recommend() reads as a crisp acquire -> timeout -> release
    shell around this body.
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

    Bounding (Task 9 / Step 7): a process-wide semaphore caps concurrent
    processing. If a permit isn't acquired within the queue timeout the
    service is saturated -> 503 fast. Once acquired, the entire processing
    body runs under an overall deadline -> 504 on expiry. The permit is
    ALWAYS released (try/finally around the acquire-to-release span),
    including on the 504 timeout path, on any other exception, and on task
    cancellation (client disconnect).
    """
    # Bounded acquire: wait_for cancels acquire() on timeout, and an
    # un-acquired permit is never released (so the 503 path leaks nothing).
    try:
        await asyncio.wait_for(
            _request_semaphore.acquire(),
            timeout=settings.recommender_queue_timeout_seconds,
        )
    except TimeoutError:
        raise HTTPException(status_code=503, detail="Recommender at capacity, retry later")

    # The try/finally spans the acquire-to-release boundary so release is
    # guaranteed on every exit path: success, the 504 deadline path below,
    # any other exception propagating from _process_recommend, and
    # CancelledError from client-disconnect task cancellation (which is NOT
    # a TimeoutError and so is not swallowed by the except below).
    try:
        async with asyncio.timeout(settings.recommender_request_deadline_seconds):
            return await _process_recommend(req)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Recommender request exceeded deadline")
    finally:
        _request_semaphore.release()
