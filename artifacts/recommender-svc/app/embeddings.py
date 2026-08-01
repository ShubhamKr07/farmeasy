from google import genai
from google.genai import types
from app.config import settings

# Bound the underlying HTTP call with settings.gemini_timeout_ms (Task 9 /
# Step 7). The request deadline in main.py governs user-facing latency; this
# http_options timeout is a provider-level backstop (see config.py docs).
_client = genai.Client(
    api_key=settings.gemini_api_key,
    http_options=types.HttpOptions(timeout=settings.gemini_timeout_ms),
)


async def embed(text: str) -> list[float]:
    """
    Embed a single string via Gemini (gemini-embedding-001), requesting
    output_dimensionality=1536 to match the recommender_cache.embedding
    column (vector(1536)) — the model defaults to 3072 dims otherwise.
    """
    resp = await _client.aio.models.embed_content(
        model=settings.embedding_model,
        contents=[text],
        config=types.EmbedContentConfig(output_dimensionality=settings.embedding_dimensions),
    )
    values = resp.embeddings[0].values
    assert values is not None
    return values
