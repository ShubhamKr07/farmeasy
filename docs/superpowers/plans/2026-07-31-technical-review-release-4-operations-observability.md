# Technical Review Release 4: Operations And Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove replica-local scheduled work, make overdue alerts correctly idempotent, add structured cross-service telemetry, and establish executable incident detection and rollback procedures.

**Architecture:** Reference data is installed by migration, never application startup. Overdue scanning runs as a short-lived Render cron command protected by a PostgreSQL transaction advisory lock. API and recommender emit correlated JSON events; Render provides service metrics and Better Stack ingests logs, heartbeat, and custom threshold alerts. Persistent PostgreSQL recommender cache is not warmed automatically.

**Tech Stack:** Drizzle/PostgreSQL advisory locks, Render Cron, Pino, Python JSON logging, Render metrics/logs, Better Stack.

## Global Constraints

- Complete Foundation, Release 1 TLS/readiness, Release 2 dashboard/cache changes, and Release 3 private topology first.
- Render cron schedule is UTC, permits one active platform run, has no disk, and must exit within 12 hours.
- Use `pg_try_advisory_xact_lock` inside one transaction; never use session advisory locks through Supabase transaction pooler.
- Cut over in two phases: remove scanner from all API replicas, verify retirement, then enable cron.
- Do not add automatic Tavily/Gemini cache warming. PostgreSQL cache is durable; paid warming needs separate budgeted feature approval.
- Never log question, answer, `ops_context`, JWT, cookies, user UUID, internal key, provider key, or full upstream payload.
- `INTERVAL_FALLBACK_SHA` always equals Task 4 Step 8 commit SHA.

---

### Task 1: Move reference growth profiles out of API startup

**Files:**

- Modify: `lib/db/src/schema/index.ts` only if a natural key/constraint is missing
- Create: `lib/db/drizzle/0017_reference_growth_profiles.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `artifacts/api-server/src/routes/growthProfiles.ts:1-70`
- Modify: `artifacts/api-server/src/index.ts:1-22`
- Modify: `scripts/src/seed-demo-data.ts`
- Create: `artifacts/api-server/src/tests/referenceData.test.ts`

**Interfaces:**

- Produces idempotent production reference profiles through migration and an explicitly guarded demo-data command.

- [ ] **Step 1: Fix reference identity.** Exact, case-sensitive, immutable `growth_profiles.name` is natural key. Preflight duplicate names, then add named `growth_profiles_name_unique`; abort with SQLSTATE `23505` before changes if duplicates exist. Operator-editable fields exclude name. Move startup `LOT-3740` through `LOT-3744` rows to guarded demo seed because they are not reference data.

- [ ] **Step 2: Write failing migration test.** Duplicate-name preflight aborts; empty DB receives exactly five rows; matching operator-edited row remains unchanged; missing rows insert; rerun changes zero rows; constraint rejects duplicate.

- [ ] **Step 3: Add forward migration and schema declaration.** Declare `name: text("name").notNull().unique("growth_profiles_name_unique")`. After duplicate preflight and constraint creation, insert exactly:

```sql
insert into public.growth_profiles
  (name, seed_name, germination_days, fertigation_days)
values
  ('Arugula (Normal)', 'Arugula', 7, 14),
  ('Allstar Gourmet Lettuce Mix', 'Allstar Gourmet Lettuce Mix', 5, 18),
  ('Toscano Kale', 'Toscano Kale', 5, 21),
  ('Zephyr Summer Squash (Normal)', 'Zephyr Summer Squash', 4, 10),
  ('Microgreen Mix', 'Microgreen Mix', 3, 7)
on conflict on constraint growth_profiles_name_unique do nothing;
```

Never use bare `ON CONFLICT DO NOTHING`, which can hide unrelated constraint failures. Do not delete or overwrite existing rows.

- [ ] **Step 4: Remove `seedDataIfEmpty` from route module and API startup.** API startup must only initialize runtime dependencies and listen.

- [ ] **Step 5: Guard demo seeding.** Require `CONFIRM_DEMO_SEED=true`, reject `NODE_ENV=production`, wrap in transaction, and call `pool.end()` in `finally`.

- [ ] **Step 6: Generate/apply migration and run tests.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name reference_growth_profiles
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/referenceData.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle artifacts/api-server/src/routes/growthProfiles.ts artifacts/api-server/src/index.ts artifacts/api-server/src/tests/referenceData.test.ts scripts/src/seed-demo-data.ts
git commit -m "refactor(api): migrate reference data out of startup"
```

### Task 2: Add cycle-specific overdue alert deduplication

**Files:**

- Modify: `lib/db/src/schema/index.ts:208-225`
- Create: `lib/db/drizzle/0018_overdue_alert_dedupe.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `artifacts/api-server/src/lib/overdue-scanner.ts:1-100`
- Create: `artifacts/api-server/src/lib/overdue-scanner.test.ts`

**Interfaces:**

```ts
export interface DatabaseExecutor {
  select: typeof db.select;
  insert: typeof db.insert;
  execute: typeof db.execute;
}

export async function scanOverdueCyclesAndAlert(options: {
  executor: DatabaseExecutor;
  now: Date;
  log: Logger;
}): Promise<{ scanned: number; created: number; updated: number }>;
```

- [ ] **Step 1: Write failing tests.** Two cycles with same seed/location create distinct alerts; rerun updates same cycle/action alert; warning upgrades to critical.

- [ ] **Step 2: Add nullable `dedupe_key`** and partial unique index for current alerts. Retain legacy `alerts_current_title_location_uniq` during migration-first deployment so old interval scanner remains safe. Key format:

```text
overdue:<cycle-id>:<fertigation|harvest>
```

- [ ] **Step 3: Backfill only scanner-identifiable existing alerts** where cycle/action can be determined unambiguously; leave manual alerts null.

- [ ] **Step 4: Refactor scanner to injected executor and fixed `now`.** Upsert by `dedupe_key`; include cycle short ID in generated title so legacy unique index cannot collide across cycles; refresh severity, description, title, and location on conflict.

- [ ] **Step 5: Generate/apply migration and run tests.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name overdue_alert_dedupe
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/lib/overdue-scanner.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle artifacts/api-server/src/lib/overdue-scanner.ts artifacts/api-server/src/lib/overdue-scanner.test.ts
git commit -m "fix(alerts): deduplicate overdue alerts per cycle"
```

### Task 3: Retire legacy alert uniqueness after scanner deployment

**Files:**

- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0019_drop_legacy_alert_unique.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Create: `artifacts/api-server/src/tests/alertIndexes.test.ts`

**Consumes:** Task 2 migration and dedupe-aware scanner deployed to staging and production; no old scanner replica remains.

- [ ] **Step 1: Write failing test** proving manual alerts may share title/location while non-null current `dedupe_key` remains unique.
- [ ] **Step 2: Remove legacy index from Drizzle schema and generate forward migration containing:**

```sql
drop index if exists alerts_current_title_location_uniq;
```

- [ ] **Step 3: Test through disposable Supabase, then commit before persistent deployment.**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:generate --name drop_legacy_alert_unique
bash scripts/ci/test-disposable-supabase.sh
git add lib/db/src/schema/index.ts lib/db/drizzle/0019_drop_legacy_alert_unique.sql lib/db/drizzle/meta/_journal.json artifacts/api-server/src/tests/alertIndexes.test.ts
git commit -m "fix(alerts): retire legacy title-location uniqueness"
```

- [ ] **Step 4: Stop for human approval.** After authorized push, staging workflow applies migration; verify dedupe-aware scanner before production promotion.

### Task 4: Build standalone locked overdue job

**Files:**

- Create: `artifacts/api-server/src/jobs/overdueScan.ts`
- Create: `artifacts/api-server/src/jobs/overdueScanCli.ts`
- Create: `artifacts/api-server/src/jobs/overdueScan.test.ts`
- Modify: `artifacts/api-server/build.mjs:17-23`
- Modify: `artifacts/api-server/package.json:6-13`

**Interfaces:**

```ts
type OverdueScanResult =
  | {
      status: "completed";
      scanned: number;
      created: number;
      updated: number;
      duration_ms: number;
    }
  | { status: "skipped_locked"; duration_ms: number }
  | { status: "disabled"; duration_ms: number };

export async function runOverdueScanJob(options?: {
  database?: typeof db;
  scanner?: typeof scanOverdueCyclesAndAlert;
  log?: Logger;
  now?: () => Date;
}): Promise<OverdueScanResult>;
```

- [ ] **Step 1: Write real PostgreSQL concurrency test** with two connections and a controlled scanner barrier. Assert one `completed`, one `skipped_locked`.

- [ ] **Step 2: Add explicit enable gate.** CLI returns `disabled` without database work unless `OVERDUE_SCAN_ENABLED === "true"`. This gate permits production resource creation without activating scanner.

- [ ] **Step 3: Use fixed signed 64-bit lock key and transaction lock.**

```ts
return database.transaction(async (tx) => {
  await tx.execute(sql`set local statement_timeout = '4min'`);
  const result = await tx.execute(sql`
    select pg_try_advisory_xact_lock(${OVERDUE_SCAN_LOCK_KEY}) as acquired
  `);
  if (!result.rows[0]?.acquired) {
    return { status: "skipped_locked", duration_ms: elapsed() };
  }
  const counts = await scanner({ executor: tx, now: now(), log });
  return { status: "completed", ...counts, duration_ms: elapsed() };
});
```

- [ ] **Step 4: Add CLI wrapper.** Log result, return zero for `completed`/`skipped_locked`/`disabled`, propagate failure, and always `pool.end()`.

- [ ] **Step 5: Add optional heartbeat ping.** When `BETTER_STACK_HEARTBEAT_URL` is configured, send one success request after `completed` or `skipped_locked`; never ping on `disabled` or failure. Unit test success, skip-without-env, disabled, and failure behavior.

- [ ] **Step 6: Add build entrypoint** producing `dist/jobs/overdueScan.mjs` and package script:

```json
"job:overdue-scan": "node --enable-source-maps dist/jobs/overdueScan.mjs"
```

- [ ] **Step 7: Run test/build.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test --test-concurrency=1 src/jobs/overdueScan.test.ts
pnpm --filter @workspace/api-server run build
test -f artifacts/api-server/dist/jobs/overdueScan.mjs
```

- [ ] **Step 8: Commit and record interval fallback SHA.** At this point API still runs dedupe-aware interval scanner. Store resulting SHA as protected GitHub production environment variable `INTERVAL_FALLBACK_SHA` and in staging/production deployment metadata; do not rely on local filesystem.

```bash
git add artifacts/api-server/src/jobs artifacts/api-server/build.mjs artifacts/api-server/package.json
git commit -m "feat(jobs): add locked overdue scan command"
git rev-parse HEAD
```

### Task 5: Remove replica-local scanner before enabling cron

**Files:**

- Modify: `artifacts/api-server/src/index.ts:20-29`
- Create: `scripts/ci/assert-api-entrypoint-pure.mjs`
- Modify: `docs/runbooks/staging-and-production-deploy.md`

- [ ] **Step 1: Add architecture assertion.** Fail when API entrypoint imports scanner/seeder or calls `setInterval`. Verify protected `INTERVAL_FALLBACK_SHA` resolves exactly to Task 4 Step 8 commit and that commit contains dedupe-aware scanner, standalone locked job, and still-active API interval scheduling before removal.

```bash
git cat-file -e "${INTERVAL_FALLBACK_SHA}^{commit}"
test "$(git rev-parse "${INTERVAL_FALLBACK_SHA}^{commit}")" = "$INTERVAL_FALLBACK_SHA"
```

- [ ] **Step 2: Remove startup scan and interval.** Do not add cron yet.

- [ ] **Step 3: Commit.**

```bash
git add artifacts/api-server/src/index.ts scripts/ci/assert-api-entrypoint-pure.mjs docs/runbooks/staging-and-production-deploy.md
git commit -m "refactor(api): remove replica-local scheduled work"
```

Stop for human approval. Push/deploy only when explicitly authorized.

- [ ] **Step 4: Deploy API-only change to staging.** Wait until every old instance is retired; verify no `overdue.scan` execution for ten minutes.

- [ ] **Step 5: Deploy API-only change to production.** Verify old replicas retired before Task 6.

### Task 6: Add Render overdue cron after scanner retirement

**Files:**

- Modify: `render.yaml`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `docs/runbooks/staging-and-production-deploy.md`

**Consumes:** Task 5 verified on all production API replicas.

- [ ] **Step 1: Add staging and production cron declarations in one commit.** Both use `OVERDUE_SCAN_ENABLED` as `sync: false`; configure staging `true` and production `false` during resource creation.

```yaml
- type: cron
  name: farmsmart-overdue-scan-staging
  runtime: node
  plan: starter
  region: oregon
  schedule: "*/5 * * * *"
  autoDeployTrigger: off
  buildCommand: npm i -g pnpm@11.17.0 && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build
  startCommand: node --enable-source-maps artifacts/api-server/dist/jobs/overdueScan.mjs
  buildFilter:
    paths:
      - artifacts/api-server/**
      - lib/db/**
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
      - tsconfig.base.json
```

Wire `DATABASE_URL`, `DATABASE_CA_CERT`, `BETTER_STACK_HEARTBEAT_URL`, and `OVERDUE_SCAN_ENABLED` from explicit environment secrets. Production starts disabled.

- [ ] **Step 2: Validate and commit declarations before resource operations.** Schedule is UTC; five-minute cadence is intentional and costs at least Render cron minimum.

```bash
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
git add render.yaml .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml docs/runbooks/staging-and-production-deploy.md
git commit -m "infra(jobs): declare gated overdue crons"
```

- [ ] **Step 3: After authorized push, sync Blueprint and capture both cron service IDs.** Deploy exact `DEPLOY_SHA` to both. Verify production runs report `disabled` and never touch database.

- [ ] **Step 4: Verify three staging scheduled runs.** Each exits, emits one status event, and creates/updates expected alerts. Do not use two Render manual triggers for lock concurrency because manual trigger cancels active run.

- [ ] **Step 5: Enable cron failure notifications** at workspace/service level and test with staging-only forced nonzero command revision. Verify Better Stack heartbeat arrives for successful run.

### Task 7: Promote production overdue cron

**Files:**

- Modify: `docs/runbooks/staging-and-production-deploy.md`

**Consumes:** Three successful staging schedules, tested failure notification, verified heartbeat, and Task 5 API scanner retirement.

- [ ] **Step 1: Verify exact SHA and disabled state.** Production cron deploy SHA equals staging-tested `DEPLOY_SHA`; last three production schedules report `disabled`; all API replicas are scanner-free.
- [ ] **Step 2: During approved window, set production `OVERDUE_SCAN_ENABLED=true` in Render.** No code or Blueprint sync occurs during activation.

- [ ] **Step 3: Monitor first three production runs.** Assert one exit event and heartbeat per schedule; verify no API-originated scanner event.
- [ ] **Step 4: Record activation and fallback SHA in runbook, then commit documentation.**

```bash
git add docs/runbooks/staging-and-production-deploy.md
git commit -m "docs(jobs): record production cron activation"
```

### Task 8: Correct recommender cache-hit semantics and add request correlation

**Files:**

- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/lib/logger.ts`
- Modify: `artifacts/api-server/src/routes/recommend.ts`
- Modify: `artifacts/recommender-svc/pyproject.toml`
- Modify: `artifacts/recommender-svc/uv.lock`
- Create: `artifacts/recommender-svc/app/logging_config.py`
- Modify: `artifacts/recommender-svc/app/main.py`
- Create: `artifacts/recommender-svc/tests/test_telemetry.py`

**Interfaces:** Stable event fields: `event`, `request_id`, `user_id_hash`, `duration_ms`, `query_name`, `cache_hit`, `upstream_timeout`, `provider_calls`, `status`, and `error_type`.

- [ ] **Step 1: Write tests** for cached, live-search, farm-context-only, and no-result responses. `cache_hit` means initial PostgreSQL vector lookup found qualifying results.

- [ ] **Step 2: Capture initial cache state immediately after first lookup.** Farm-context-only answer must not report cache hit.

- [ ] **Step 3: Establish request ID.** Prefer Render `Rndr-Id`, then inbound `x-request-id`, then UUID. Return it in response header and forward it to private recommender.

- [ ] **Step 4: Hash user ID.** Use truncated SHA-256; never log raw UUID.

- [ ] **Step 5: Configure Python JSON logging.** Add pinned dependency and locked `uv.lock`; emit one bounded JSON object per event.

- [ ] **Step 6: Log provider dimensions.** Include model, operation, call count, input characters/provider units, output tokens when available, success, and duration. Exclude content.

- [ ] **Step 7: Run sensitive-canary tests.** Assert logs do not contain seeded fake JWT, internal key, question, answer, or raw user UUID.

```bash
pnpm --filter @workspace/api-server run test
uv sync --directory artifacts/recommender-svc --locked
uv run --directory artifacts/recommender-svc pytest tests/test_telemetry.py -v
```

- [ ] **Step 8: Commit.**

```bash
git add artifacts/api-server/src/app.ts artifacts/api-server/src/lib/logger.ts artifacts/api-server/src/routes/recommend.ts artifacts/recommender-svc/pyproject.toml artifacts/recommender-svc/uv.lock artifacts/recommender-svc/app/logging_config.py artifacts/recommender-svc/app/main.py artifacts/recommender-svc/tests/test_telemetry.py
git commit -m "obs: correlate API and recommender events"
```

### Task 9: Instrument dashboard, readiness, and overdue job events

**Files:**

- Modify: `artifacts/api-server/src/services/dashboardSnapshot.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/routes/recommend.ts`
- Modify: `artifacts/api-server/src/routes/seedLots.ts`
- Modify: `artifacts/api-server/src/routes/health.ts`
- Modify: `lib/db/src/index.ts`
- Modify: `artifacts/api-server/src/jobs/overdueScan.ts`
- Modify: `artifacts/recommender-svc/app/db.py`
- Modify: `artifacts/recommender-svc/app/main.py`
- Modify: `artifacts/recommender-svc/tests/test_telemetry.py`
- Create: `artifacts/api-server/src/tests/telemetry.test.ts`

- [ ] **Step 1: Write captured-log tests** for success/failure duration and sensitive canaries.

- [ ] **Step 2: Emit stable events:**

```text
dashboard.snapshot
readiness.database
overdue.scan
recommend.proxy
recommender.recommend
rate_limit.exceeded
database.pool
```

- [ ] **Step 3: Emit bounded limiter events.** Custom `express-rate-limit` handlers emit `rate_limit.exceeded` before 429 with service, request ID, hashed user ID when applicable, limiter (`recommend_per_user` or `seed_lot_lookup_ip`), route, limit, window, and `status: rejected`. Never log IP, limiter key, raw UUID, question, headers, or body. Tests prove first 20 recommendations emit none, 21st emits exactly one, seed-lot 31st emits one, and sensitive canaries are absent.

- [ ] **Step 4: Emit pool snapshots.** API emits `database.pool` with every readiness event from `pg.Pool.totalCount`, `idleCount`, and `waitingCount`. Recommender emits at request completion/failure from asyncpg size/max/idle; waiter may be null when unavailable. Fields: driver, size, max, idle, in-use, waiting, utilization percent, and status. `saturated` means utilization at least 80% or waiting greater than zero. Tests cover API `8/10`, recommender `4/5`, waiter saturation, healthy/null-waiter, and absence of DSN/SQL/arguments/secrets.

- [ ] **Step 5: Use monotonic duration measurement** and stable workload status values `completed`, `failed`, `skipped_locked`; pool events use `healthy`/`saturated` as defined above.

- [ ] **Step 6: Run tests and commit.**

```bash
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/telemetry.test.ts src/jobs/overdueScan.test.ts
git add artifacts/api-server/src/services/dashboardSnapshot.ts artifacts/api-server/src/app.ts artifacts/api-server/src/routes/recommend.ts artifacts/api-server/src/routes/seedLots.ts artifacts/api-server/src/routes/health.ts lib/db/src/index.ts artifacts/api-server/src/jobs/overdueScan.ts artifacts/api-server/src/tests/telemetry.test.ts artifacts/recommender-svc/app/db.py artifacts/recommender-svc/app/main.py artifacts/recommender-svc/tests/test_telemetry.py
git commit -m "obs: instrument database and scheduled workloads"
```

### Task 10: Configure actionable monitoring and incident runbook

**Files:**

- Create: `docs/adr/ADR-005.md`
- Create: `docs/runbooks/incident-response.md`
- Modify: `docs/runbooks/staging-bootstrap.md`

**Architecture decision:** Use Render native deploy/service/cron notifications plus Better Stack log ingestion, heartbeat, and custom log-query alerts. Record cost, retention, owner, and deletion path in ADR-005.

- [ ] **Step 1: Create Better Stack staging and production sources plus cron heartbeats.** Keep source tokens and `BETTER_STACK_HEARTBEAT_URL` values in Render/GitHub secrets. Configure Render log drain or documented service integration; never commit tokens.

- [ ] **Step 2: Create monitors:**
  - `recommend.proxy` timeout ratio above 2% for 15 minutes.
  - `dashboard.snapshot` p95 `duration_ms` above 1,000 ms for 15 minutes.
  - `readiness.database` failure immediately.
  - Overdue cron heartbeat missing for 15 minutes.
  - Provider-call anomaly above agreed daily budget.
  - `rate_limit.exceeded` count at least 5 in rolling 15 minutes, grouped by environment/service/limiter.
  - `database.pool` with `status=saturated` count at least 3 in rolling 5 minutes, grouped by environment/service.

- [ ] **Step 3: Test each monitor** with synthetic staging event/heartbeat. For limiter/pool monitors, inject uniquely tagged `synthetic=true` events into staging source: five limiter events within 15 minutes and three saturated pool events within 5 minutes. Require one notification and resolved state for each without lowering production thresholds; capture UTC time, monitor, synthetic ID, redacted payload, and notification. Confirm production receives no synthetic event. Recovery requires no match for 10 minutes.

- [ ] **Step 4: Write runbook** covering request-ID trace, advisory-lock inspection, cache freshness SQL, timeout/cost diagnosis, readiness checks, safe cron rerun, secret-canary audit, two-phase rollback, owners, and expected recovery times.

- [ ] **Step 5: Add cache diagnostics.**

```sql
select count(*) as cached_documents, max(fetched_at) as latest_fetch
from recommender_cache;
```

- [ ] **Step 6: Commit.**

```bash
git add docs/adr/ADR-005.md docs/runbooks/incident-response.md docs/runbooks/staging-bootstrap.md
git commit -m "docs(obs): define monitoring and incident response"
```

## Release 4 Verification Gate

```bash
pnpm run typecheck
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run build
test -f artifacts/api-server/dist/jobs/overdueScan.mjs
uv run --directory artifacts/recommender-svc pytest -v
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

Required evidence:

- API startup has no seed, scan, or interval side effects.
- Concurrent job test returns one `completed` and one `skipped_locked`.
- Overdue alert dedupe is cycle/action-specific and severity updates.
- Three staging and three production cron runs exit successfully.
- Cache-hit semantics pass all four cases.
- Correlated JSON logs contain required fields and no sensitive canaries.
- Rate-limit handlers and API/recommender pool serializers emit bounded healthy/saturated evidence.
- Rate-limit and database-pool monitors each deliver synthetic staging notification.
- Every monitor has delivered one synthetic staging notification.

## Rollback

- Cron cutover: set `OVERDUE_SCAN_ENABLED=false`, wait for active run to finish, then redeploy exact Task 4 `INTERVAL_FALLBACK_SHA`, which contains cycle-specific dedupe, legacy-index retirement, standalone job, and active interval scheduling. Never deploy pre-Task-2 scanner or reverse rollback order.
- Job code: redeploy last-good job SHA; additive schema remains.
- Telemetry: revert logging commit if serialization or volume causes incident; preserve runbook and native request logs.
- Better Stack: disable log drain/monitors; Render native notifications remain.
- Database migrations remain forward-only.
