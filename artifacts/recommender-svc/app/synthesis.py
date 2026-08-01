import logging
from google import genai
from google.genai import types
from app.config import settings

logger = logging.getLogger(__name__)

# Same HTTP-timeout backstop as embeddings.py (Task 9 / Step 7).
_client = genai.Client(
    api_key=settings.gemini_api_key,
    http_options=types.HttpOptions(timeout=settings.gemini_timeout_ms),
)


async def synthesize_answer(question: str, docs: list[dict], farm_context_text: str | None) -> str | None:
    """
    Grounds an answer in the cached/fetched external docs (cited by [n]) and
    the farm's own operational data, if any matched. Uses the same Gemini
    key as embeddings.py (one provider, one key) instead of a separate
    Anthropic account. Returns None if the Gemini call fails for any reason
    (rate limit, transient outage) — caller falls back to the raw top-match
    answer (R2 behavior) rather than 500ing the whole request over a
    third-party API hiccup.
    """
    doc_block = "\n\n".join(
        f"[{i + 1}] {d['title'] or d['source_url']} ({d['source_url']})\n{d['content'][:1500]}"
        for i, d in enumerate(docs)
    )
    farm_block = f"\n\nFarm data:\n{farm_context_text}" if farm_context_text else ""

    prompt = (
        "You are a vertical-farming operations assistant. Answer the "
        "grower's question using ONLY the external knowledge and farm "
        "data below. Cite external sources by their [n] marker inline. "
        "If the farm's own data conflicts with the general external "
        "knowledge, prefer the farm's own data and say so explicitly.\n\n"
        f"Question: {question}\n\n"
        f"External knowledge:\n{doc_block}"
        f"{farm_block}\n\n"
        "Answer concisely, 3-6 sentences."
    )

    try:
        resp = await _client.aio.models.generate_content(
            model=settings.gemini_chat_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=1024,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception:
        logger.exception("Gemini synthesis failed, falling back to raw top-match answer")
        return None

    return resp.text
