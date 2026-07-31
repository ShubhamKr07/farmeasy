# Technical Review Release 2: Performance And Scalability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard, metrics, history, layout, frontend loading, and recommender ingestion costs scale with bounded working sets rather than retained history or concurrent duplicate work.

**Architecture:** PostgreSQL performs date filtering and aggregation. History APIs expose deterministic cursor envelopes backed by matching composite indexes. Dashboard UI lazy-loads routes, mounts only active panels, and batches metric requests. Recommender workers use database lease claims plus a unique URL constraint to deduplicate paid embedding calls across requests and replicas.

**Tech Stack:** PostgreSQL 17, Drizzle, Express, OpenAPI/Orval, React Query, Vite/Vitest, FastAPI/asyncpg, Gemini embeddings.

## Global Constraints

- Complete the CI/staging foundation first. Use disposable PostgreSQL for every query test.
- Release 1 Task 4 API route harness is required for backend integration tests.
- Preserve dashboard snapshot response fields at `artifacts/api-server/src/routes/dashboard.ts:269-295`.
- Every default history request is bounded; do not preserve an unbounded legacy path.
- Update Drizzle schema before generating migrations; never hand-edit only migration SQL and leave schema drift.
- Every generated migration commits matching `meta/NNNN_snapshot.json` and generated journal entry. Never manually append journal entries for generated migrations.
- Update OpenAPI and generated clients in the same commit as response-contract changes.
- Use facility-local reporting boundaries from `docs/metrics-data-dictionary.md`, not host-local rolling windows.

---

### Task 0: Repair Drizzle migration metadata

**Files:**

- Create: `lib/db/drizzle/meta/0012_snapshot.json`
- Create: `lib/db/drizzle/meta/0013_snapshot.json`
- Verify unchanged: `lib/db/drizzle/meta/_journal.json`

- [ ] **Step 1: Reconstruct `0012_snapshot.json` in disposable worktree.** Start from `b692245^`, apply only `b692245` schema enum change, run `db:generate --name fix_user_role_enum`, and copy only generated snapshot.
- [ ] **Step 2: Reconstruct `0013_snapshot.json`.** Against repaired `0012`, run `drizzle-kit generate --custom --name cast_user_id_columns_to_uuid`; retain existing hand-authored `0013_cast_user_id_columns_to_uuid.sql` and copy only snapshot.
- [ ] **Step 3: Preserve shipped journal identity.** Do not alter `idx`, `when`, or `tag` for entries `0012`/`0013`; changing timestamps can make deployed databases consider applied migration pending.
- [ ] **Step 4: Verify chain.** Assert `0012.prevId === 0011.id`, `0013.prevId === 0012.id`, IDs unique, `0012` contains corrected four-value `user_role`, and `0013` contains UUID/FK state for every converted `user_id`.
- [ ] **Step 5: Prove zero residual diff.** In disposable copy run `db:generate --name metadata_probe`; require `No schema changes, nothing to migrate`. Any generated enum, UUID, or FK statement blocks `0014`.
- [ ] **Step 6: Commit metadata repair separately.** Stage only two reconstructed snapshots; journal and SQL migrations remain byte-identical.

```bash
git diff --exit-code -- lib/db/drizzle/meta/_journal.json lib/db/drizzle/0012_fix_user_role_enum.sql lib/db/drizzle/0013_cast_user_id_columns_to_uuid.sql
git add lib/db/drizzle/meta/0012_snapshot.json lib/db/drizzle/meta/0013_snapshot.json
git commit -m "fix(db): repair Drizzle metadata chain"
```

### Task 1: Canonicalize operational timestamps as UTC instants

**Files:**

- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0014_timestamp_with_timezone.sql`
- Create: `lib/db/drizzle/meta/0014_snapshot.json`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Create: `scripts/verify-timestamp-semantics.sql`
- Create: `artifacts/api-server/src/tests/timestampSemantics.test.ts`

**Interfaces:** Every operational timestamp uses PostgreSQL `timestamptz` and Drizzle `{ withTimezone: true }`; facility timezone affects grouping/display, not storage.

- [ ] **Step 1: Audit all 36 `timestamp(...)` columns** in `lib/db/src/schema/index.ts`. Sample production epochs before migration and verify existing values represent UTC wall-clock values written by Render/JavaScript clients.

- [ ] **Step 2: Write failing test** around UTC instant round-trip and facility-local day/week conversion, including DST transition.

- [ ] **Step 3: Update Drizzle schema** to `timestamp(name, { withTimezone: true })` for every instant column. Do not change date-only columns.

- [ ] **Step 4: Generate migration using explicit UTC interpretation.** Inspect every generated `ALTER COLUMN ... TYPE timestamptz` statement. For example, `cycles.created_at` must use `USING created_at AT TIME ZONE 'UTC'`. The committed migration contains all 36 literal table/column names discovered from `lib/db/src/schema/index.ts`; no generic dynamic SQL.

- [ ] **Step 5: Verify epoch preservation.** `verify-timestamp-semantics.sql` compares pre-recorded samples and asserts every audited column has `timestamp with time zone` type.

- [ ] **Step 6: Add production lock preflight and abort criteria.** Record `pg_total_relation_size` for every rewritten table, active write transactions, and expected rewrite duration from staging data at production-equivalent scale. Set migration-local `lock_timeout = '5s'` and `statement_timeout = '15min'`. Abort before production when any table exceeds tested size, lock wait exceeds five seconds, or staging rewrite exceeds ten minutes; reschedule a maintenance window instead of retrying live.

- [ ] **Step 7: Apply during approved low-write staging window and run tests.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name timestamp_with_timezone
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/timestampSemantics.test.ts
```

- [ ] **Step 8: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle scripts/verify-timestamp-semantics.sql artifacts/api-server/src/tests/timestampSemantics.test.ts
git commit -m "fix(db): store operational timestamps as UTC instants"
```

### Task 2: Extract dashboard snapshot and aggregate in SQL

**Files:**

- Create: `artifacts/api-server/src/services/dashboardSnapshot.ts`
- Modify: `artifacts/api-server/src/routes/dashboard.ts:30-305`
- Modify: `artifacts/api-server/src/routes/recommend.ts:1-42,73-80`
- Modify: `artifacts/api-server/src/lib/metrics/tz.ts`
- Create: `artifacts/api-server/src/tests/services/dashboardSnapshot.test.ts`
- Create: `scripts/perf/explain-dashboard-snapshot.sql`

**Interfaces:**

- Produces:

```ts
export interface DashboardSnapshot {
  // Exact fields currently returned by dashboard.ts:269-295.
}

export async function computeDashboardSnapshot(
  now: Date = new Date(),
): Promise<DashboardSnapshot>;
```

- [ ] **Step 1: Write DB-backed failing tests.** Insert rows immediately before, at, and after facility-local week/month boundaries; include future rows, soft-deleted cycles, old completed cycles, current/critical alerts, and both bad-tray data eras.

- [ ] **Step 2: Run focused test.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test --test-concurrency=1 \
src/tests/services/dashboardSnapshot.test.ts
```

- [ ] **Step 3: Move service out of route module.** Use the injected `now` for every calculation; never mix `Date.now()` and database `now()`.

- [ ] **Step 4: Replace full-row loads with SQL aggregates.** Aggregate weekly/monthly yield, weekly waste, total/recent bad trays, and current/critical alerts in SQL. Follow cutover-aware bad-tray definition in `docs/metrics-data-dictionary.md:75-83`.

- [ ] **Step 5: Bound bucket joins.** Add raw `dateCol >= bucketStart AND dateCol < bucketEnd` predicates inside `LEFT JOIN ... ON` before `date_trunc`, preserving empty generated buckets.

- [ ] **Step 6: Keep HTTP route thin and change recommender import** to `services/dashboardSnapshot.ts`.

- [ ] **Step 7: Run tests and capture plans.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server run test
psql "$STAGING_DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f scripts/perf/explain-dashboard-snapshot.sql
```

- [ ] **Step 8: Commit.**

```bash
git add artifacts/api-server/src/services/dashboardSnapshot.ts artifacts/api-server/src/routes/dashboard.ts artifacts/api-server/src/routes/recommend.ts artifacts/api-server/src/lib/metrics/tz.ts artifacts/api-server/src/tests/services/dashboardSnapshot.test.ts scripts/perf/explain-dashboard-snapshot.sql
git commit -m "perf(api): aggregate dashboard snapshot in SQL"
```

### Task 3: Define and enforce metric window semantics

**Files:**

- Modify: `lib/metrics/src/templates.ts:11-55`
- Modify: `lib/metrics/src/registry-overview.ts`
- Modify: `lib/metrics/src/registry-shipments.ts`
- Modify: `lib/metrics/src/registry-inventory.ts`
- Modify: `artifacts/api-server/src/routes/metrics.ts:18-57`
- Modify: `artifacts/api-server/src/lib/metrics/templates.ts:47-183`
- Modify: `artifacts/api-server/src/lib/metrics/tz.ts:42-54`
- Modify: `artifacts/api-server/src/tests/metrics/metrics.test.ts`
- Modify: `artifacts/api-server/src/tests/metrics/parity.test.ts`
- Modify: `artifacts/api-server/src/tests/metrics/fixtures/seed.sql`

**Interfaces:**

- Add optional date metadata:

```ts
interface ScalarAggParams {
  dateCol?: string;
}
interface GroupByParams {
  dateCol?: string;
}
interface RatioParams {
  numDateCol?: string;
  denDateCol?: string;
}
interface TableParams {
  dateCol?: string;
}
```

- [ ] **Step 1: Make fixture dates relative to test execution.** Replace fixed June/July 2026 dates with SQL expressions around one captured fixture `now`.

- [ ] **Step 2: Write failing tests** for `7d`, `30d`, `90d`, fixed-window metrics, all-time metrics, ratios, empty buckets, and invalid range values.

- [ ] **Step 3: Derive effective range from registry definition.**

```ts
const effectiveRange =
  def.window === "range"
    ? requestedRange
    : def.window === "7d" || def.window === "30d" || def.window === "90d"
      ? def.window
      : "all";
```

- [ ] **Step 4: Add lower and exclusive upper bounds** to scalar, grouped, ratio, and table templates when their date metadata exists. Apply identical bounds to ratio numerator and denominator.

- [ ] **Step 5: Fix bucket resolution.** Use hourly buckets for 24-hour sensor views, daily for 7d/30d/90d, weekly/monthly only where registry specifies them. Do not return 24 hours for a 90-day request.

- [ ] **Step 6: Run tests and typecheck shared contracts.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server run test:metrics
pnpm run typecheck:libs
pnpm run typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add lib/metrics/src artifacts/api-server/src/routes/metrics.ts artifacts/api-server/src/lib/metrics artifacts/api-server/src/tests/metrics
git commit -m "fix(metrics): enforce reporting window semantics"
```

### Task 4: Add deterministic history indexes and cursor contracts

**Files:**

- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0015_query_performance_indexes.sql`
- Create: `lib/db/drizzle/meta/0015_snapshot.json`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `lib/api-spec/openapi.yaml`
- Regenerate: `lib/api-client-react/src/generated/`, `lib/api-zod/src/generated/`
- Modify: `artifacts/api-server/src/routes/sensor-readings.ts:18-43`
- Modify: `artifacts/api-server/src/routes/alerts.ts:23-45`
- Modify: `artifacts/api-server/src/routes/badTrays.ts:11-75`
- Modify: `artifacts/admin-dashboard/src/pages/alerts/Alerts.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/bad-trays/BadTrays.tsx`
- Modify: `artifacts/farmeasy/components/AlertsBell.tsx`
- Modify: `artifacts/farmeasy/app/alerts.tsx`
- Create: `artifacts/api-server/src/tests/routes/history.test.ts`

**Interfaces:**

```ts
type CursorPage<T> = { items: T[]; nextCursor: string | null };
type HistoryCursor = { timestamp: string; id: number };
```

Default limit `50`; maximum `200`. Cursor encodes timestamp plus ID. `GET /alerts` remains bounded `Alert[]` for installed clients; additive `GET /alerts/page` returns cursor envelope. Sensor and bad-tray history use envelopes directly; no endpoint remains unbounded.

- [ ] **Step 1: Write failing tests** for equal timestamps, page boundaries, invalid cursor, maximum limit, status-filtered alerts, and bad-tray summary independent of detail page. Assert legacy `GET /alerts` still returns JSON array for `{ status, limit }`, defaults to at most 50, and rejects/clamps above 200; assert `GET /alerts/page` returns `{ items, nextCursor }`.

- [ ] **Step 2: Add matching Drizzle indexes.**

```sql
create index sensor_readings_sensor_read_id_idx
  on sensor_readings (sensor_id, read_at desc, id desc);
create index sensor_readings_read_id_idx
  on sensor_readings (read_at desc, id desc);
create index alerts_status_created_id_idx
  on alerts (status, created_at desc, id desc);
create index manual_checks_bad_created_id_idx
  on manual_checks (created_at desc, id desc)
  where is_bad_trays = true;
```

Do not use `CONCURRENTLY`; current Drizzle migrator wraps migrations in a transaction. Schedule production application during low-write window.

- [ ] **Step 3: Generate migration from schema and inspect it.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name query_performance_indexes
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
```

- [ ] **Step 4: Implement tuple keyset ordering.**

```sql
where (read_at, id) < ($cursor_read_at, $cursor_id)
order by read_at desc, id desc
limit $limit_plus_one
```

- [ ] **Step 5: Update OpenAPI and clients additively.** Retain `/alerts` operationId `listAlerts` and array response. Add `/alerts/page` operationId `listAlertsPage` with `AlertCursorPage`. Define sensor envelopes and keep bad-tray aggregate fields plus bounded `manualEntries`/`nextCursor`.

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
```

- [ ] **Step 6: Update source consumers without breaking installed clients.** Dashboard alerts and new FarmEasy alerts-screen use `listAlertsPage` with “Load more”. Keep `listAlerts` for installed-client compatibility and first-page bell/overview consumers. Deploy additive API first, smoke old array calls, then dashboard/mobile update. Do not remove `/alerts` in Release 2.

- [ ] **Step 7: Run tests and executable plan assertions.** Seed representative history, run `ANALYZE`, then `EXPLAIN (FORMAT JSON, COSTS OFF)` inside transaction with `SET LOCAL enable_seqscan = off`. Recursively assert exact index names `sensor_readings_sensor_read_id_idx`, `sensor_readings_read_id_idx`, `alerts_status_created_id_idx`, and `manual_checks_bad_created_id_idx`, with no ordering `Sort` node.

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test --test-concurrency=1 src/tests/routes/history.test.ts
pnpm run typecheck
```

- [ ] **Step 8: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle lib/api-spec/openapi.yaml lib/api-client-react/src/generated lib/api-zod/src/generated artifacts/api-server/src/routes artifacts/api-server/src/tests/routes/history.test.ts artifacts/admin-dashboard/src/pages/alerts artifacts/admin-dashboard/src/pages/bad-trays artifacts/farmeasy/components/AlertsBell.tsx artifacts/farmeasy/app/alerts.tsx
git commit -m "perf(api): paginate operational history"
```

### Task 5: Make tray-count mutation atomic and hierarchy assembly linear

**Files:**

- Modify: `artifacts/api-server/src/routes/layout.ts:49-86,274-305,389-426`
- Create: `artifacts/api-server/src/tests/routes/layout.test.ts`

- [ ] **Step 1: Write failing tests** for concurrent tray-count changes, partial-delete failure, and large hierarchy output. Add one characterization test documenting current occupied-tray behavior; do not expect occupancy enforcement in this task.

- [ ] **Step 2: Wrap tray-count mutation in transaction.** Lock rack row with `SELECT ... FOR UPDATE`; set-delete `rack_id = id AND position_index >= count`; batch insert missing positions.

- [ ] **Step 3: Build hierarchy from maps.** Pre-index channels by room, racks by channel, and trays by rack once; preserve current sort order. Preserve current deletion semantics; tray-occupancy enforcement is deferred until cycle placement uses reliable `tray_id` data.

- [ ] **Step 4: Run integration tests.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test --test-concurrency=1 src/tests/routes/layout.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add artifacts/api-server/src/routes/layout.ts artifacts/api-server/src/tests/routes/layout.test.ts
git commit -m "perf(layout): make hierarchy and tray updates bounded"
```

### Task 6: Add dashboard test harness and lazy loading

**Files:**

- Modify: `artifacts/admin-dashboard/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `artifacts/admin-dashboard/vitest.config.ts`
- Create: `artifacts/admin-dashboard/src/test/setup.ts`
- Modify: `artifacts/admin-dashboard/src/App.tsx:12-44`
- Modify: `artifacts/admin-dashboard/src/components/layout/AppLayout.tsx:7-53`
- Create: `artifacts/admin-dashboard/src/components/layout/AppLayout.test.tsx`

- [ ] **Step 1: Install test dependencies.** Reconcile existing lockfile edits before staging.

```bash
pnpm --filter @workspace/admin-dashboard add -D \
  vitest jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom
```

Add `"test": "vitest run"` to dashboard package scripts. CI must fail if Vitest reports zero test files.

- [ ] **Step 2: Add standalone Vitest config.** Do not import `vite.config.ts`, which requires `PORT` and `BASE_PATH`. Add jsdom polyfills for `ResizeObserver`, `PointerEvent`, and `scrollIntoView` only when tests require them.

- [ ] **Step 3: Write failing test.** Inactive panels are absent and their mocked hooks execute zero times; active panel hook executes once.

- [ ] **Step 4: Lazy-load named route exports** with `React.lazy(...then(module => ({ default: module.Export })))`; wrap route switch in `Suspense`.

- [ ] **Step 5: Render one active panel component, not five closed sheets.** Wrap lazy panel in `Suspense`.

- [ ] **Step 6: Run tests/build and inspect chunks.**

```bash
pnpm --filter @workspace/admin-dashboard run test
pnpm --filter @workspace/admin-dashboard run typecheck
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/admin-dashboard run build
```

- [ ] **Step 7: Commit.**

```bash
git add artifacts/admin-dashboard/package.json artifacts/admin-dashboard/vitest.config.ts artifacts/admin-dashboard/src/test artifacts/admin-dashboard/src/App.tsx artifacts/admin-dashboard/src/components/layout/AppLayout.tsx artifacts/admin-dashboard/src/components/layout/AppLayout.test.tsx pnpm-lock.yaml
git commit -m "perf(dashboard): defer routes and inactive panels"
```

### Task 7: Batch dashboard metric HTTP requests

**Files:**

- Create: `artifacts/admin-dashboard/src/components/metrics/useMetricBatch.ts`
- Modify: `artifacts/admin-dashboard/src/components/metrics/TierBMetricCard.tsx:32-92`
- Modify: `artifacts/admin-dashboard/src/pages/overview/Overview.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/inventory/Inventory.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/shipments/Shipments.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/accounting/Accounting.tsx`
- Create: `artifacts/admin-dashboard/src/components/metrics/useMetricBatch.test.tsx`

**Interfaces:**

```ts
export function useMetricBatch(
  tab: MetricTab,
  ids: string[],
  range: MetricRange,
): {
  data: Record<string, unknown> | undefined;
  isLoading: boolean;
  isError: boolean;
};
```

- [ ] **Step 1: Write failing test.** Three selected Tier-B IDs create one request; drag reorder does not change query key or refetch.

- [ ] **Step 2: Sort filtered Tier-B IDs before joining** and call existing comma-separated `GET /api/metrics` once.

- [ ] **Step 3: Make `TierBMetricCard` presentation-only.** Pass `payload`, `isLoading`, and `isError`; remove card-level hook.

- [ ] **Step 4: Update all four page owners.** Clarify acceptance: this reduces browser HTTP/auth overhead; backend still executes one metric operation per key.

- [ ] **Step 5: Run tests/typecheck and commit.**

```bash
pnpm --filter @workspace/admin-dashboard run test
pnpm --filter @workspace/admin-dashboard run typecheck
git add artifacts/admin-dashboard/src/components/metrics artifacts/admin-dashboard/src/pages/overview/Overview.tsx artifacts/admin-dashboard/src/pages/inventory/Inventory.tsx artifacts/admin-dashboard/src/pages/shipments/Shipments.tsx artifacts/admin-dashboard/src/pages/accounting/Accounting.tsx
git commit -m "perf(dashboard): batch metric HTTP requests"
```

### Task 8: Deduplicate recommender ingestion across replicas

**Files:**

- Modify: `lib/db/src/schema/index.ts:511-529`
- Create: `lib/db/drizzle/0016_recommender_ingest_claims.sql`
- Create: `lib/db/drizzle/meta/0016_snapshot.json`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `artifacts/recommender-svc/app/embed_upsert.py:8-44`
- Create: `artifacts/recommender-svc/tests/test_embed_upsert.py`

**Interfaces:**

- Keeps `async def upsert_cache_docs(docs: list[dict]) -> int`.
- Adds `recommender_ingest_claims(source_url PK, owner_id UUID, claimed_at timestamptz)` and unique `recommender_cache.source_url`.

- [ ] **Step 1: Write concurrent AnyIO test.** Two calls with same URL produce one embedding invocation and one cache row; loser waits for winner row rather than returning early.

- [ ] **Step 2: Deduplicate existing cache rows** by newest `fetched_at`, then replace non-unique source URL index with unique index.

- [ ] **Step 3: Add claim table and RLS.** Trusted recommender DB role uses it; no Data API policies.

- [ ] **Step 4: Claim with five-minute lease takeover.**

```sql
insert into recommender_ingest_claims (source_url, owner_id)
values ($1, $2)
on conflict (source_url) do update
set owner_id = excluded.owner_id, claimed_at = now()
where recommender_ingest_claims.claimed_at < now() - interval '5 minutes'
returning owner_id;
```

- [ ] **Step 5: Add module-level semaphore.**

```python
_EMBED_SEMAPHORE = asyncio.Semaphore(3)
```

Stable-deduplicate URLs inside each call. Winners embed and insert; losers poll boundedly for resulting cache row or lease expiry. Delete own claim in `finally`.

- [ ] **Step 6: Generate/apply migration and run tests.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name recommender_ingest_claims
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
uv run --directory artifacts/recommender-svc pytest tests/test_embed_upsert.py -v
uv run --directory artifacts/recommender-svc pytest -v
```

- [ ] **Step 7: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle artifacts/recommender-svc/app/embed_upsert.py artifacts/recommender-svc/tests/test_embed_upsert.py
git commit -m "perf(recommender): lease duplicate cache ingestion"
```

## Release 2 Verification Gate

```bash
pnpm run typecheck
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/admin-dashboard run test
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/admin-dashboard run build
uv run --directory artifacts/recommender-svc pytest -v
```

Required evidence:

- Dashboard SQL scans bounded ranges and preserves response contract.
- Metric ranges match registry semantics and fixture boundaries.
- History defaults are capped and composite indexes appear in query plans.
- Legacy `GET /alerts` remains bounded array; paginated clients use additive `/alerts/page`.
- Closed panels issue no requests; selected metrics issue one HTTP call per tab/range.
- Concurrent duplicate sources generate one paid embedding call.

## Rollback

- Keep additive indexes and unique constraints; revert application code independently.
- Cursor contract rollback requires regenerating clients from prior OpenAPI and redeploying API/dashboard together.
- Claim-table migration is additive; old recommender ignores it. Redeploy prior recommender while retaining schema.
- Never remove forward migrations from history.
