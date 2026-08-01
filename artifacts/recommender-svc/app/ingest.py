import httpx
import dlt
from app.config import settings
from app.tls import CA_CERT_PATH

DATASET_NAME = "recommender_staging"


def _unpooled_database_url(settings=settings) -> str:
    """
    dlt's postgres destination (psycopg2) sets search_path via a connection
    startup parameter, which Supabase's transaction pooler rejects outright
    ("unsupported startup parameter in options: search_path"), same failure
    mode Neon's pooled endpoint had. asyncpg (cache_repo.py, embed_upsert.py)
    doesn't hit this, so only dlt's connection needs the session-pooler URL.

    Unlike Neon, Supabase's pooled and direct/session hostnames are not
    related by substring — this must be an explicit separate connection
    string (ADR-003), not derived from the pooled one.
    """
    if not settings.database_url_direct:
        raise ValueError(
            "DATABASE_URL_DIRECT must be set (Supabase session-pooler "
            "connection string) — dlt's ingestion pipeline cannot use the "
            "transaction-pooler DATABASE_URL."
        )
    # CA-pinned TLS (Release 1 Task 10): psycopg2 (under dlt) needs the CA as
    # a FILE PATH (sslrootcert=, written by app.tls.write_ca_cert_file at
    # startup), and sslmode=verify-full enforces strict CA + hostname
    # verification — the prior default encrypted but did not validate the
    # server cert. Append defensively: use "&" if the DSN already carries
    # query params, "?" otherwise (DATABASE_URL_DIRECT as documented has
    # none, but a future Supabase string might).
    base = settings.database_url_direct
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}sslmode=verify-full&sslrootcert={CA_CERT_PATH}"


def _fetch_tavily_rows(query: str, max_results: int) -> list[dict]:
    """
    Extract half of the "search API -> dlt -> cache" pipeline. Issues the
    Tavily /search POST directly via a synchronous httpx.Client with finite
    connect/read/write/pool timeouts (Task 9 / Step 7) and returns the same
    projected row shape the previous dlt rest_api_resources source produced
    (it selected the response body's top-level `results` array).

    This is a SYNC function and intentionally uses a sync httpx.Client (not
    AsyncClient) because the whole thing runs inside a worker thread via
    asyncio.to_thread from main.py — introducing an event loop here would
    nest loops. The load half (dlt pipeline.run into Postgres) happens in
    run_tavily_ingest and is unchanged.
    """
    if not settings.tavily_api_key:
        return []

    t = settings.tavily_timeout_seconds
    with httpx.Client(timeout=httpx.Timeout(connect=t, read=t, write=t, pool=t)) as client:
        resp = client.post(
            "https://api.tavily.com/search",
            headers={
                "Authorization": f"Bearer {settings.tavily_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
                "include_answer": False,
            },
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])

    def project(item: dict) -> dict:
        return {
            "source_url": item["url"],
            "title": item.get("title"),
            "content": item.get("content", ""),
            "search_provider": "tavily",
            "query_text": query,
        }

    return [project(item) for item in results if item.get("content")]


def run_tavily_ingest(query: str, max_results: int = 5) -> list[dict]:
    """
    Fetches live Tavily results for `query` and loads them into a dlt-owned
    Postgres schema (recommender_staging.raw_docs on the same Neon DB),
    merge-deduped on source_url so the same page resurfacing across
    different questions doesn't pile up duplicate rows. Returns the fetched
    rows so the caller can embed + upsert the new ones into
    recommender_cache (dlt doesn't know about pgvector — that step is
    separate, see embed_upsert.py).

    Blocking (dlt/psycopg2 are sync) — callers on the async request path
    must run this via asyncio.to_thread.
    """
    rows = _fetch_tavily_rows(query, max_results)
    if not rows:
        return []

    pipeline = dlt.pipeline(
        pipeline_name="recommender_ingest",
        destination=dlt.destinations.postgres(credentials=_unpooled_database_url()),
        dataset_name=DATASET_NAME,
    )
    pipeline.run(rows, table_name="raw_docs", write_disposition="merge", primary_key="source_url")
    return rows
