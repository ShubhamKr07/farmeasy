import dlt
from dlt.sources.rest_api import RESTAPIConfig, rest_api_resources
from app.config import settings

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
    return settings.database_url_direct


def _fetch_tavily_rows(query: str, max_results: int) -> list[dict]:
    """
    dlt's declarative REST API source handles the Tavily HTTP call (bearer
    auth, JSON body, response-path selection via data_selector) — this is
    the extract half of the "search API -> dlt -> cache" pipeline.
    """
    config: RESTAPIConfig = {
        "client": {
            "base_url": "https://api.tavily.com",
            "auth": {"type": "bearer", "token": settings.tavily_api_key},
        },
        "resource_defaults": {
            "endpoint": {
                "method": "POST",
                "json": {
                    "query": query,
                    "max_results": max_results,
                    "search_depth": "basic",
                    "include_answer": False,
                },
            },
        },
        "resources": [
            {
                "name": "raw_docs",
                "endpoint": {"path": "search", "data_selector": "results"},
            },
        ],
    }
    (resource,) = rest_api_resources(config)

    def project(item: dict) -> dict:
        return {
            "source_url": item["url"],
            "title": item.get("title"),
            "content": item.get("content", ""),
            "search_provider": "tavily",
            "query_text": query,
        }

    rows = [project(item) for item in resource if item.get("content")]
    return rows


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
