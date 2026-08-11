from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

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


@asynccontextmanager
async def tenant_scope(org_id: int, facility_id: int) -> AsyncIterator[asyncpg.pool.PoolConnectionProxy]:
    """
    The asyncpg equivalent of lib/db/src/scope.ts's `withTenantScope` (MT-M2
    task #5): acquires ONE pooled connection, opens a transaction on it, and
    sets the transaction-local `app.org_id` / `app.facility_id` session
    variables via Postgres's `set_config(name, value, true)` builtin (third
    arg `true` = "is_local", so the setting resets automatically at
    transaction end -- required under Supabase's transaction-pooler
    connection reuse, exactly like the Node side; see scope.ts's own comment
    for the full rationale). This is what lets the non-BYPASSRLS
    `farmsmart_recommender` role be scoped by the EXISTING role-agnostic RLS
    policies (00007's facility_id/organization_id GUC policies, 00022's
    crops policy) -- no new per-table policy needed for those tables, only
    the SELECT grants documented in the role-rotation runbook.

    Callers MUST run their reads on the YIELDED connection (`conn.fetch(...)`
    / `conn.fetchrow(...)`), not by calling `get_pool()` again -- a fresh
    `pool.fetch(...)` call acquires its OWN connection from the pool (a
    different physical connection, or the same one after this transaction
    has already ended), which would never see the GUCs set here. asyncpg's
    `Connection`/pool-connection-proxy exposes the same `fetch`/`fetchrow`/
    `execute` methods as `Pool`, so query code written against `pool.fetch`
    only needs the connection object swapped in, not rewritten.

    Statement caching is already disabled pool-wide (`statement_cache_size=0`
    in `create_pool`, see above) for pooler compatibility -- no
    per-connection handling needed here.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT set_config('app.org_id', $1, true)", str(org_id))
            await conn.execute("SELECT set_config('app.facility_id', $1, true)", str(facility_id))
            yield conn
