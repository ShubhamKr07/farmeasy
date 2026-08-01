from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Env vars (Render): DATABASE_URL (Supabase transaction-pooler connection
    string, app runtime), DATABASE_URL_DIRECT (Supabase session-pooler
    connection string — required only for dlt's psycopg2-based ingestion,
    which needs session-level SQL the transaction pooler rejects; see
    ADR-003), GEMINI_API_KEY (embeddings + synthesis — one provider, one
    key), TAVILY_API_KEY (live search on cache miss — optional),
    INTERNAL_API_KEY (shared secret validating requests came from
    api-server, not the public internet).
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    database_url_direct: str | None = None
    # PEM-encoded "Supabase Root 2021 CA" pinning TLS for the DB connection
    # (Release 1 Task 10). Required (fail-closed) for both asyncpg
    # (app/db.py) and dlt/psycopg2 (app/ingest.py); see app/tls.py. Maps to
    # the DATABASE_CA_CERT env var via pydantic-settings' default
    # snake_case-field -> UPPERCASE_ENV mapping (same as database_url ->
    # DATABASE_URL).
    database_ca_cert: str | None = None
    gemini_api_key: str
    tavily_api_key: str | None = None
    internal_api_key: str
    embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 1536
    gemini_chat_model: str = "gemini-2.5-flash"

    # --- Request bounding (Task 9 / Step 7) -------------------------------
    # api-server's /recommend proxy aborts at 10s (sub-task B's
    # AbortSignal.timeout(10_000)). This service must always finish — or fail
    # with our own clean 504 — strictly before that, so the end user sees our
    # 504 semantics rather than api-server's hard abort / connection reset.
    # 9s leaves ~1s headroom for proxy overhead, network RTT, and JSON
    # serialization on the recommender -> api-server hop.
    recommender_request_deadline_seconds: float = 9

    # How long an incoming request will wait for a free processing slot
    # (semaphore permit) before failing fast with 503. Under saturation we
    # want callers rejected quickly rather than queueing up and burning
    # api-server's 10s budget; 1s absorbs transient burst contention while
    # still failing fast on sustained overload. Combined with the 9s
    # processing deadline, worst-case end-to-end (~10s) stays within
    # api-server's 10s proxy budget.
    recommender_queue_timeout_seconds: float = 1

    # Max in-flight /recommend processing. The recommender is a single ASGI
    # process; bounding concurrent work prevents thread/connection exhaustion
    # and protects the shared Gemini quota from a single hot instance. 8 is a
    # modest ceiling for a Python single-process worker with async I/O.
    recommender_max_concurrent_requests: int = 8

    # Gemini SDK HTTP timeout in MILLISECONDS. google-genai's HttpOptions
    # takes an int ms value. The 9s request deadline above governs
    # user-facing latency (it cancels the awaiting coroutine); this is a
    # provider-level backstop that bounds the underlying HTTP call if asyncio
    # cancellation does not fully propagate to the SDK's transport. 30s is a
    # clearly-separate backstop — well above the deadline so it never trips
    # during normal operation, yet finite so a hung socket cannot linger
    # indefinitely.
    gemini_timeout_ms: int = 30_000

    # Per-component httpx timeout (seconds) for the direct Tavily /search
    # fetch in ingest.py. Applied uniformly to connect/read/write/pool so
    # every phase of the HTTP call is bounded. NOTE: the live Tavily fetch
    # runs in a worker thread via asyncio.to_thread; cancelling the
    # requesting coroutine (e.g. the 9s deadline expiring) does NOT stop
    # that thread — so the finite httpx timeout is what actually bounds an
    # orphaned fetch thread's lifetime. 10s is a backstop; the 9s request
    # deadline governs user-facing latency.
    tavily_timeout_seconds: float = 10


settings = Settings()  # type: ignore[call-arg]
