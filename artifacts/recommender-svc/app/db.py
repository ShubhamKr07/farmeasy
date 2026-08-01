import asyncpg
from app.config import settings
from app.tls import build_asyncpg_ssl_context

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            settings.database_url,
            min_size=1,
            max_size=5,
            # CA-pinned TLS (Release 1 Task 10): asyncpg's ssl="require"
            # string mode encrypts but does NOT validate the server cert
            # (the same MITM gap the Node side closed in lib/db). Passing an
            # ssl.SSLContext built from the pinned Supabase Root 2021 CA
            # enforces CERT_REQUIRED + check_hostname (full verification).
            ssl=build_asyncpg_ssl_context(),
            # Supabase's transaction pooler (PgBouncer) does not support
            # prepared statements consistently across pooled connections;
            # disabling asyncpg's statement cache avoids a class of
            # pooler-incompatibility errors. Known asyncpg+PgBouncer
            # requirement.
            statement_cache_size=0,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
