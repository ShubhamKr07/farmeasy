"""
MT-M2 task #5, Task 6 — recommender tenant-scoped grounding isolation proof.

Two layers, per the design brief's testing note:

  1. APP-LAYER MECHANISM (always runs, no DB needed): `tenant_scope()`
     (app/db.py) must set the `app.org_id` / `app.facility_id` GUCs on ONE
     connection BEFORE any read runs, and `get_farm_context()` (app/
     farm_context.py) must run its crops/growth_profiles/bad_tray_entries
     reads on THAT SAME connection — never a separate, unscoped
     `get_pool().fetch(...)` call that would bypass the GUC (and therefore
     RLS) entirely. Also proves the mechanism is correctly PARAMETERIZED per
     call: two different (org_id, facility_id) pairs produce two different
     `set_config` calls, never a fixed/leaked/stale value — the concurrency
     hazard a shared or cached connection/transaction would create. Proven
     with a fake asyncpg pool/connection that records every call, in order.

  2. LIVE DB PROOF (role-gated, mirrors the api-server suite's demo.test.ts/
     crops.test.ts pattern): only runs the real two-tenant cross-tenant-deny
     check when `TEST_DATABASE_URL` is set AND a real, non-BYPASSRLS
     `farmsmart_recommender` role exists in that database. The disposable-CI
     stack this repo's `scripts/ci/test-disposable-supabase.sh` spins up
     wires neither today: no `TEST_DATABASE_URL` is passed into the
     recommender's `pytest` run, and no migration in this repo's history
     ever `CREATE ROLE farmsmart_recommender` in a fresh CI database — the
     role is provisioned by the user, per
     `docs/runbooks/recommender-rls-role-rotation.md`. So this SKIPS in CI
     rather than asserting anything under a BYPASSRLS connection (which
     would see every row regardless of policy and produce a meaningless
     pass — or, worse, a false pass if this check were ever inverted). When
     a real role exists (a local harness with the role created per the
     runbook, or staging), the live two-tenant deny check runs for real —
     confirmed directly against a local disposable Supabase stack with
     `farmsmart_recommender` provisioned during this task's development.
     Structural coverage for the RLS policies themselves lives in
     `supabase/tests/00023_recommender_rls.test.sql` (pgTAP).
"""

import asyncio
import os
import uuid

import pytest


def _bootstrap_env(monkeypatch):
    """Settings() requires these at import time — set before importing app.*."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host:5432/db")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")


# --------------------------------------------------------------------------- #
# 1. App-layer mechanism proof (mocked, always runs)
# --------------------------------------------------------------------------- #


class _FakeTransaction:
    def __init__(self, recorder):
        self.recorder = recorder

    async def __aenter__(self):
        self.recorder.append(("tx_enter",))
        return self

    async def __aexit__(self, *exc):
        self.recorder.append(("tx_exit",))
        return False


class _FakeConnection:
    """Records every execute/fetch/fetchrow call, in order, with its args."""

    def __init__(self, recorder, crops=None, growth_profiles=None, bad_trays=None):
        self.recorder = recorder
        self._crops = crops or []
        self._growth_profiles = growth_profiles or []
        self._bad_trays = bad_trays or []

    def transaction(self):
        return _FakeTransaction(self.recorder)

    async def execute(self, query, *args):
        self.recorder.append(("execute", query, args))

    async def fetch(self, query, *args):
        self.recorder.append(("fetch", query, args))
        if "FROM crops" in query:
            return self._crops
        if "DISTINCT seed_name FROM growth_profiles" in query:
            return [{"seed_name": r["seed_name"]} for r in self._growth_profiles]
        if "FROM bad_tray_entries" in query:
            return self._bad_trays
        return []

    async def fetchrow(self, query, *args):
        self.recorder.append(("fetchrow", query, args))
        if "crop_id = $1" in query:
            crop_id = args[0]
            return next((gp for gp in self._growth_profiles if gp.get("crop_id") == crop_id), None)
        if "seed_name = $1" in query:
            seed_name = args[0]
            return next((gp for gp in self._growth_profiles if gp.get("seed_name") == seed_name), None)
        return None


class _FakeAcquireCtx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return _FakeAcquireCtx(self._conn)


def test_tenant_scope_sets_guc_before_farm_context_reads_on_same_connection(monkeypatch):
    """tenant_scope must set_config app.org_id/app.facility_id BEFORE any
    read, and get_farm_context must run its reads on that SAME connection —
    never a separate, unscoped pool call that would bypass the GUC."""
    _bootstrap_env(monkeypatch)
    import app.db as db_module
    import app.farm_context as farm_context_module

    recorder = []
    conn = _FakeConnection(
        recorder,
        crops=[{"id": 1, "name": "Lettuce"}],
        growth_profiles=[{"crop_id": 1, "seed_name": "Lettuce"}],
        bad_trays=[],
    )
    pool = _FakePool(conn)

    async def fake_get_pool():
        return pool

    monkeypatch.setattr(db_module, "get_pool", fake_get_pool)

    result = asyncio.run(farm_context_module.get_farm_context(42, 7, "How is my lettuce doing?"))

    assert result is not None
    calls = recorder

    execute_positions = [i for i, c in enumerate(calls) if c[0] == "execute"]
    assert len(execute_positions) == 2, "exactly the two GUC set_config calls, no other execute()"
    org_call = calls[execute_positions[0]]
    facility_call = calls[execute_positions[1]]
    assert org_call[1] == "SELECT set_config('app.org_id', $1, true)"
    assert org_call[2] == ("42",)
    assert facility_call[1] == "SELECT set_config('app.facility_id', $1, true)"
    assert facility_call[2] == ("7",)

    last_guc_position = execute_positions[-1]
    read_positions = [i for i, c in enumerate(calls) if c[0] in ("fetch", "fetchrow")]
    assert read_positions, "get_farm_context must actually issue reads"
    assert all(p > last_guc_position for p in read_positions), (
        "every farm_context read must happen AFTER both tenant GUCs are set"
    )


def test_tenant_scope_parameterizes_guc_per_call_never_a_fixed_value(monkeypatch):
    """Two different tenants must produce two different set_config calls —
    proves the mechanism can't leak a stale/hardcoded org+facility id across
    requests."""
    _bootstrap_env(monkeypatch)
    import app.db as db_module
    import app.farm_context as farm_context_module

    recorder_a, recorder_b = [], []
    conn_a = _FakeConnection(
        recorder_a, crops=[{"id": 1, "name": "Basil"}], growth_profiles=[{"crop_id": 1, "seed_name": "Basil"}]
    )
    conn_b = _FakeConnection(
        recorder_b, crops=[{"id": 2, "name": "Basil"}], growth_profiles=[{"crop_id": 2, "seed_name": "Basil"}]
    )
    pools = iter([_FakePool(conn_a), _FakePool(conn_b)])

    async def fake_get_pool():
        return next(pools)

    monkeypatch.setattr(db_module, "get_pool", fake_get_pool)

    asyncio.run(farm_context_module.get_farm_context(101, 201, "basil question"))
    asyncio.run(farm_context_module.get_farm_context(102, 202, "basil question"))

    a_sets = [c for c in recorder_a if c[0] == "execute"]
    b_sets = [c for c in recorder_b if c[0] == "execute"]
    assert a_sets[0][2] == ("101",) and a_sets[1][2] == ("201",)
    assert b_sets[0][2] == ("102",) and b_sets[1][2] == ("202",)
    assert a_sets != b_sets, "distinct tenants must never share identical GUC values"


def test_tenant_scope_uses_the_same_connection_object_for_all_reads(monkeypatch):
    """Regression guard for the exact class of bug this task fixes: farm_context
    used to call `get_pool()` directly (a separate, unscoped connection per
    query) — assert `get_pool()` is invoked exactly ONCE per get_farm_context
    call (by tenant_scope itself), not once per read."""
    _bootstrap_env(monkeypatch)
    import app.db as db_module
    import app.farm_context as farm_context_module

    recorder = []
    conn = _FakeConnection(
        recorder,
        crops=[{"id": 1, "name": "Kale"}],
        growth_profiles=[{"crop_id": 1, "seed_name": "Kale"}],
        bad_trays=[{"issue": "mold", "severity": "high", "created_at": "2026-08-01"}],
    )
    pool = _FakePool(conn)
    call_count = 0

    async def counting_get_pool():
        nonlocal call_count
        call_count += 1
        return pool

    monkeypatch.setattr(db_module, "get_pool", counting_get_pool)

    result = asyncio.run(farm_context_module.get_farm_context(1, 1, "kale question"))

    assert result is not None
    assert call_count == 1, "get_pool() must be called exactly once (by tenant_scope), not per-query"


# --------------------------------------------------------------------------- #
# 2. Live DB proof, role-gated (skips unless a real, non-BYPASSRLS
#    farmsmart_recommender role is provisioned — see the module docstring)
# --------------------------------------------------------------------------- #


def test_live_cross_tenant_isolation_under_real_farmsmart_recommender_role():
    async def scenario():
        import asyncpg

        database_url = os.environ.get("TEST_DATABASE_URL")
        if not database_url:
            pytest.skip("TEST_DATABASE_URL not set -- no live DB to test against")

        conn = await asyncpg.connect(database_url)
        try:
            role_row = await conn.fetchrow(
                "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'farmsmart_recommender'"
            )
            if role_row is None or role_row["rolbypassrls"]:
                pytest.skip(
                    "farmsmart_recommender is not provisioned as a non-BYPASSRLS role in "
                    "this database -- live RLS-deny proof skipped (see "
                    "docs/runbooks/recommender-rls-role-rotation.md). Structural coverage: "
                    "supabase/tests/00023_recommender_rls.test.sql."
                )

            tx = conn.transaction()
            await tx.start()
            try:
                suffix = uuid.uuid4().hex[:8]
                org_a = await conn.fetchval(
                    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
                    f"Isolation Org A {suffix}",
                )
                org_b = await conn.fetchval(
                    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
                    f"Isolation Org B {suffix}",
                )
                facility_a = await conn.fetchval(
                    "INSERT INTO facilities (name, organization_id, facility_name, timezone) "
                    "VALUES ($1, $2, $1, 'UTC') RETURNING id",
                    "Isolation Facility A",
                    org_a,
                )
                facility_b = await conn.fetchval(
                    "INSERT INTO facilities (name, organization_id, facility_name, timezone) "
                    "VALUES ($1, $2, $1, 'UTC') RETURNING id",
                    "Isolation Facility B",
                    org_b,
                )
                seed_name_a = f"IsolationSeedA-{suffix}"
                seed_name_b = f"IsolationSeedB-{suffix}"
                crop_a = await conn.fetchval(
                    "INSERT INTO crops (name, organization_id) VALUES ($1, $2) RETURNING id",
                    seed_name_a,
                    org_a,
                )
                crop_b = await conn.fetchval(
                    "INSERT INTO crops (name, organization_id) VALUES ($1, $2) RETURNING id",
                    seed_name_b,
                    org_b,
                )
                gp_a = await conn.fetchval(
                    "INSERT INTO growth_profiles "
                    "(name, seed_name, germination_days, fertigation_days, crop_id, organization_id) "
                    "VALUES ($1, $1, 3, 10, $2, $3) RETURNING id",
                    seed_name_a,
                    crop_a,
                    org_a,
                )
                gp_b = await conn.fetchval(
                    "INSERT INTO growth_profiles "
                    "(name, seed_name, germination_days, fertigation_days, crop_id, organization_id) "
                    "VALUES ($1, $1, 3, 10, $2, $3) RETURNING id",
                    seed_name_b,
                    crop_b,
                    org_b,
                )
                cycle_a = await conn.fetchval(
                    "INSERT INTO cycles "
                    "(short_id, seed_lot_qr_codes, seed_name, seed_weight_tray, growth_profile_id, "
                    " seeding_date, facility_id) "
                    "VALUES ($1, '{}', $2, 1, $3, CURRENT_DATE, $4) RETURNING id",
                    f"iso-a-{suffix}",
                    seed_name_a,
                    gp_a,
                    facility_a,
                )
                cycle_b = await conn.fetchval(
                    "INSERT INTO cycles "
                    "(short_id, seed_lot_qr_codes, seed_name, seed_weight_tray, growth_profile_id, "
                    " seeding_date, facility_id) "
                    "VALUES ($1, '{}', $2, 1, $3, CURRENT_DATE, $4) RETURNING id",
                    f"iso-b-{suffix}",
                    seed_name_b,
                    gp_b,
                    facility_b,
                )
                await conn.execute(
                    "INSERT INTO bad_tray_entries (cycle_id, issue, severity) VALUES ($1, 'root rot', 'high')",
                    cycle_a,
                )
                await conn.execute(
                    "INSERT INTO bad_tray_entries (cycle_id, issue, severity) VALUES ($1, 'root rot', 'high')",
                    cycle_b,
                )

                # Read AS the recommender role, scoped to org A / facility A --
                # exactly the tenant_scope() mechanism (app/db.py), just issued
                # directly here since this connection is the seeding admin, not
                # a fresh pool connection.
                await conn.execute("SET LOCAL ROLE farmsmart_recommender")
                await conn.execute("SELECT set_config('app.org_id', $1, true)", str(org_a))
                await conn.execute("SELECT set_config('app.facility_id', $1, true)", str(facility_a))

                crops_seen = await conn.fetch(
                    "SELECT id FROM crops WHERE id = ANY($1::int[])", [crop_a, crop_b]
                )
                crop_ids_seen = {r["id"] for r in crops_seen}
                assert crop_a in crop_ids_seen, "org A must see its own crop"
                assert crop_b not in crop_ids_seen, "org A must never see org B's crop"

                gp_seen = await conn.fetch(
                    "SELECT id FROM growth_profiles WHERE id = ANY($1::int[])", [gp_a, gp_b]
                )
                gp_ids_seen = {r["id"] for r in gp_seen}
                assert gp_a in gp_ids_seen, "org A must see its own growth profile"
                assert gp_b not in gp_ids_seen, "org A must never see org B's growth profile"

                bad_tray_seen = await conn.fetch(
                    """
                    SELECT bte.cycle_id
                    FROM bad_tray_entries bte
                    JOIN cycles c ON c.id = bte.cycle_id
                    WHERE bte.cycle_id = ANY($1::int[])
                    """,
                    [cycle_a, cycle_b],
                )
                cycle_ids_seen = {r["cycle_id"] for r in bad_tray_seen}
                assert cycle_a in cycle_ids_seen, (
                    "org A must see its own bad-tray row via the cycles join"
                )
                assert cycle_b not in cycle_ids_seen, (
                    "org A must never see org B's bad-tray row -- the cycles join's "
                    "facility-GUC policy (00007) is what scopes this, since "
                    "bad_tray_entries' own farmsmart_recommender policy (00023) is "
                    "intentionally unscoped"
                )
            finally:
                await tx.rollback()
        finally:
            await conn.close()

    asyncio.run(scenario())
