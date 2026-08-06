# Technical Review Release 4: Operations And Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove replica-local scheduled work, make overdue alerts correctly idempotent, add structured cross-service telemetry, establish executable incident detection and rollback procedures, and layer PostHog error tracking plus Self-driving remediation on top of the operational plane.

**Architecture:** Reference data is installed by migration, never application startup. Overdue scanning runs as a short-lived Render cron command protected by a PostgreSQL transaction advisory lock. API and recommender emit correlated JSON events; Render provides service metrics and Better Stack ingests logs, heartbeat, and custom threshold alerts. Persistent PostgreSQL recommender cache is not warmed automatically. PostHog is a separate, second observability plane: it captures only code exceptions (never operational logs), groups them into issues, symbolicates stack traces against deployed source maps, and feeds Self-driving which opens human-reviewed draft PRs. A scheduled GitHub Actions workflow joins PostHog error data with GitHub PR state and emails a daily digest over existing SMTP. Better Stack remains the real-time operational alert authority; PostHog never replaces it.

**Tech Stack:** Drizzle/PostgreSQL advisory locks, Render Cron, Pino, Python JSON logging, Render metrics/logs, Better Stack, PostHog (`posthog-js`, `posthog-node`, `posthog` Python SDK), PostHog Self-driving (open beta), PostHog CLI (source-map upload), Nodemailer/SMTP.

## Global Constraints

- Complete Foundation, Release 1 TLS/readiness, Release 2 dashboard/cache changes, and Release 3 private topology first.
- Render cron schedule is UTC, permits one active platform run, has no disk, and must exit within 12 hours.
- Use `pg_try_advisory_xact_lock` inside one transaction; never use session advisory locks through Supabase transaction pooler.
- Cut over in two phases: remove scanner from all API replicas, verify retirement, then enable cron.
- Do not add automatic Tavily/Gemini cache warming. PostgreSQL cache is durable; paid warming needs separate budgeted feature approval.
- Never log question, answer, `ops_context`, JWT, cookies, user UUID, internal key, provider key, or full upstream payload.
- `INTERVAL_FALLBACK_SHA` always equals Task 4 Step 8 commit SHA.
- PostHog uses the existing US Cloud project only. EU is out of scope.
- PostHog scope is error tracking only: no product-analytics autocapture, no session replay, no PostHog Logs, no code-variable capture, no mobile native-crash plugin in this release. Adding any of those is a separate, later plan.
- Every PostHog-captured exception must carry `environment`, `service`, `release`, `request_id`, and `error_type`. `user_id_hash` (the truncated SHA-256 already emitted by Task 8) is the only user identifier sent; never send the raw user UUID.
- PostHog capture must never include request bodies, question text, answer text, `ops_context`, SQL, bind arguments, headers, JWTs, cookies, emails, provider request/response payloads, internal keys, or provider keys. The redaction rule is identical to the Pino rule above and is enforced by seeded canary tests on every runtime.
- PostHog clients are fail-open: any initialization failure, network failure, or missing token must not affect user requests, the API, the dashboard, the recommender, or existing Pino logging.
- PostHog project tokens (`POSTHOG_KEY` / `VITE_POSTHOG_KEY` / `EXPO_PUBLIC_POSTHOG_KEY`) are public ingestion tokens; they may be present in client bundles. The PostHog **personal API key** (`POSTHOG_PERSONAL_API_KEY`) is a secret used only for source-map upload and report reads; never commit it, never expose it to clients.
- Self-driving is permitted to open draft pull requests against `ShubhamKr07/farmsmart` only. It must never: push to `main`, auto-merge, auto-deploy, bypass required CI, bypass the production approval gate, touch auth/authorization code, secrets, cryptography, database migrations, `render.yaml`, or the deploy workflows without explicit human initiation. Branch protection, required `CI / Required` status, exact-SHA staging promotion, and the `production` environment approval rule all remain the sole deploy authorities.
- PostHog capture on production stays disabled (tokens absent) until Tasks 11-14 pass their staging evidence gates. Mobile (Task 15) is a follow-up that ships with the next planned EAS build; it is not on the production-promotion critical path of Tasks 11-14.

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

> **PostHog dependency (Tasks 11-15):** `request_id`, `user_id_hash`, `service`, `environment`, `release`, and `error_type` are the shared correlation contract. PostHog reuses the truncated-SHA-256 `user_id_hash` produced in Step 4 — it must never receive the raw user UUID. If this task changes any of those field names or shapes, update Task 11's PostHog property mapping in the same release.

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

**Architecture decision:** Two observability planes, not one. **Operational plane** = Render native deploy/service/cron notifications plus Better Stack log ingestion, heartbeat, and custom log-query alerts — owns readiness, latency, database-pool saturation, cron heartbeat, rate-limit spikes, and provider-cost anomalies; it pages the operator in real time. **Error plane** = PostHog Error Tracking — owns grouped code exceptions, stack-trace symbolication, release/commit attribution, and Self-driving draft-PR remediation; it never pages and never replaces Better Stack. The daily SMTP digest (Task 14) is a summary only, never an alert channel. ADR-005 records cost, retention, owner, deletion path, and the explicit ownership table for each signal (`dashboard.snapshot`, `database.pool`, `$exception`, etc.) so an on-call engineer never wonders which tool owns a given symptom.

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

- [ ] **Step 4: Write runbook** covering request-ID trace, advisory-lock inspection, cache freshness SQL, timeout/cost diagnosis, readiness checks, safe cron rerun, secret-canary audit, two-phase rollback, owners, expected recovery times, **and the PostHog error-plane recovery procedures**: how to disable capture (remove `POSTHOG_KEY`/`VITE_POSTHOG_KEY`/`EXPO_PUBLIC_POSTHOG_KEY`), how to pause Self-driving (toggle the Error Tracking signal source off in the PostHog inbox; revoke the GitHub integration to stop draft-PR creation without losing issue history), how to verify source-link attribution after a deploy, and how to recover the daily SMTP digest (re-provision `POSTHOG_SMTP_*` secrets and run the workflow's `workflow_dispatch` test delivery). The runbook must state that disabling PostHog never affects Better Stack, Render metrics, or the deploy pipeline.

- [ ] **Step 5: Add cache diagnostics.**

```sql
select count(*) as cached_documents, max(fetched_at) as latest_fetch
from recommender_cache;
```

- [ ] **Step 6: Commit.**

```bash
git add docs/adr/ADR-005.md docs/runbooks/incident-response.md docs/runbooks/staging-bootstrap.md
git commit -m "docs(obs): define dual-plane monitoring and incident response"
```

### Task 11: Add PostHog runtime exception capture (API, dashboard, recommender)

**Files:**

- Create: `artifacts/api-server/src/lib/posthog.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/index.ts`
- Modify: every API route that currently swallows an exception via bare `console.error` (grep `console.error` under `artifacts/api-server/src/routes/`)
- Create: `artifacts/api-server/src/tests/posthog.test.ts`
- Create: `artifacts/admin-dashboard/src/lib/posthog.ts`
- Modify: `artifacts/admin-dashboard/src/main.tsx`
- Create: `artifacts/admin-dashboard/src/components/PostHogErrorFallback.tsx`
- Create: `artifacts/recommender-svc/app/posthog_client.py`
- Modify: `artifacts/recommender-svc/app/main.py`
- Modify: `artifacts/recommender-svc/app/config.py`
- Create: `artifacts/recommender-svc/tests/test_posthog.py`
- Modify: `artifacts/api-server/package.json`, `artifacts/admin-dashboard/package.json`, `artifacts/recommender-svc/pyproject.toml`, `artifacts/recommender-svc/uv.lock`, `pnpm-lock.yaml`
- Modify: `render.yaml` (add `POSTHOG_KEY`, `POSTHOG_HOST` to api-server and recommender; add `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` to dashboard)

**Consumes:** Task 8's `request_id`, `user_id_hash`, `service`, `environment`, `release`, `error_type` correlation fields.

**Interfaces:**

```ts
// artifacts/api-server/src/lib/posthog.ts
export const posthog: PostHog | null;           // null when POSTHOG_KEY absent (fail-open)
export function captureServerError(err: unknown, context: {
  request_id?: string; user_id_hash?: string; route?: string;
  status?: number; error_type?: string;
}): void;
```

```python
# artifacts/recommender-svc/app/posthog_client.py
def get_posthog() -> Posthog | None: ...        # None when POSTHOG_KEY absent (fail-open)
def capture_service_error(err: BaseException, context: dict) -> None: ...
```

- [ ] **Step 1: Write failing canary tests first.** `artifacts/api-server/src/tests/posthog.test.ts` asserts: (a) with no `POSTHOG_KEY`, `posthog` is `null` and `captureServerError` is a no-op that never throws; (b) with a fake token and a stubbed transport, an Express error produces exactly one `$exception` event whose properties contain `environment`, `service: "api"`, `release`, `request_id`, `error_type`, and `user_id_hash`, and whose properties and message do **not** contain the seeded canaries (fake JWT, internal key, raw UUID, question text, answer text, cookie, `ops_context`). `test_posthog.py` asserts the same shape for the recommender, plus that the captured exception never contains the question, the answer, the farm context, or the Gemini/Tavily payload.

- [ ] **Step 2: Add the API client module.** Create `artifacts/api-server/src/lib/posthog.ts`. Initialize `new PostHog(process.env.POSTHOG_KEY ?? "", { host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com", enableExceptionAutocapture: false, flushAt: 20, flushInterval: 10_000 })` only when `POSTHOG_KEY` is non-empty; otherwise export `null`. Disable person profiles, GeoIP, and session replay at the client level. Expose `captureServerError(err, ctx)` which calls `posthog.captureException(err, { distinctId: ctx.user_id_hash ?? "anonymous", properties: { environment, service: "api", release: process.env.RENDER_GIT_COMMIT?.slice(0,12) ?? "unknown", request_id, error_type, route, status } })` and wraps the call in `try/catch` so it can never throw into the request path. Release/version wiring is finalized in Task 12; here it is `"unknown"`.

- [ ] **Step 3: Wire the Express error handler.** In `artifacts/api-server/src/app.ts`, import `setupExpressErrorHandler` from `posthog-node` and call it **after** all routes are mounted (mirroring the existing route registration order) so unhandled Express exceptions are captured. The handler must run before the process exits; it must not alter the response status or body. Confirm the existing Pino request log still fires.

- [ ] **Step 4: Replace bare `console.error` call sites with the bounded reporter.** For each API route currently doing `console.error(err)` inside a `catch` (grep under `src/routes/`), call `captureServerError(err, { request_id, user_id_hash, route: req.path, error_type: err?.name ?? "Error" })` and keep the existing operational behavior (status code, response). Do not capture expected validation errors (HTTP 4xx from Zod). Do not capture in test runs unless `POSTHOG_KEY` is explicitly set in the test env.

- [ ] **Step 5: Add graceful shutdown flush.** In `artifacts/api-server/src/index.ts`, after `app.listen`, register a `process.on("beforeExit")` / `SIGTERM` handler that calls `await posthog?.shutdown()` and `pool.end()` in `finally`. Capture must never block request handling; shutdown flush is bounded to the SDK's internal timeout.

- [ ] **Step 6: Add the dashboard client.** Create `artifacts/admin-dashboard/src/lib/posthog.ts` initializing `posthog-js` with `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST`, `autocapture: false`, `session_recording: { maskAllInputs: true, maskAllText: true, blockAllMedia: true }` (defense in depth — replay stays off in this release), `disable_session_recording: true`, `opt_out_capturing_by_default: false`, `loaded` hook that sets `posthog.debug()` only when `import.meta.env.DEV`. Export `captureClientError(err, ctx)` mirroring the API shape. Create `PostHogErrorFallback.tsx` that calls `captureClientError` and renders the existing fallback markup; wire it as a top-level error boundary in `main.tsx` around `<App />`. Do **not** remove the existing Replit runtime-error-overlay dev plugin.

- [ ] **Step 7: Add the recommender client.** Create `artifacts/recommender-svc/app/posthog_client.py` with `get_posthog()` returning `Posthog(POSTHOG_KEY, host=POSTHOG_HOST, enable_exception_autocapture=False, disable_geoip=True)` or `None`. In `app/main.py`, add an `@app.exception_handler(Exception)` that calls `capture_service_error(exc, {"environment","service":"recommender","release":os.environ.get("RENDER_GIT_COMMIT","unknown")[:12],"request_id":...})` then re-raises the existing HTTPException/500 behavior. Never pass `req.question`, `req.ops_context`, the synthesized answer, the farm context, or the provider payload into the capture context.

- [ ] **Step 8: Add env vars to `render.yaml`.** For `farmsmart-api` and both staging mirrors: add `POSTHOG_KEY` (`sync: false`, public ingestion token) and `POSTHOG_HOST` (`value: https://us.i.posthog.com`). For the recommender and its staging mirror: same two keys. For the dashboard and its staging mirror: add `VITE_POSTHOG_KEY` (`sync: false`) and `VITE_POSTHOG_HOST` (`value: https://us.i.posthog.com`). Leave production values unset until Task 14's gate passes; staging can be provisioned now. Run `render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text`.

- [ ] **Step 9: Run tests and commit.**

```bash
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/posthog.test.ts
pnpm run typecheck
uv run --directory artifacts/recommender-svc pytest tests/test_posthog.py -v
git add artifacts/api-server/src/lib/posthog.ts artifacts/api-server/src/app.ts artifacts/api-server/src/index.ts artifacts/api-server/src/routes artifacts/api-server/src/tests/posthog.test.ts artifacts/admin-dashboard/src/lib/posthog.ts artifacts/admin-dashboard/src/main.tsx artifacts/admin-dashboard/src/components/PostHogErrorFallback.tsx artifacts/recommender-svc/app/posthog_client.py artifacts/recommender-svc/app/main.py artifacts/recommender-svc/app/config.py artifacts/recommender-svc/tests/test_posthog.py artifacts/api-server/package.json artifacts/admin-dashboard/package.json artifacts/recommender-svc/pyproject.toml artifacts/recommender-svc/uv.lock pnpm-lock.yaml render.yaml
git commit -m "feat(obs): add PostHog runtime exception capture (api, dashboard, recommender)"
```

### Task 12: Upload source maps and tag releases (API + dashboard)

**Files:**

- Modify: `artifacts/api-server/build.mjs`
- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/admin-dashboard/vite.config.ts`
- Modify: `artifacts/admin-dashboard/package.json`
- Modify: `.github/workflows/deploy-staging.yml`, `.github/workflows/deploy-production.yml`
- Modify: `render.yaml` (document the `POSTHOG_CLI_*` build-time vars in comments; they are build-only, not runtime)

**Consumes:** Task 11's clients; the exact CI-tested SHA from the deploy workflows.

- [ ] **Step 1: API source maps via esbuild.** `artifacts/api-server/build.mjs` already emits `sourcemap: "linked"`. Verify `dist/index.mjs` and `dist/index.mjs.map` exist post-build. The API runs the unminified bundle directly, so frames already point near source — the goal here is release attribution, not de-obfuscation. Add a post-build step that invokes `posthog-cli sourcemap inject --directory dist` then `posthog-cli sourcemap upload --directory dist --release-name farmsmart-api --release-version "$DEPLOY_SHA"` gated on `POSTHOG_CLI_API_KEY` being set; skip silently when unset so local/CI builds without secrets still pass.

- [ ] **Step 2: Dashboard source maps via Vite.** Add `@posthog/rollup-plugin` to `artifacts/admin-dashboard/package.json`. In `vite.config.ts`, add the plugin only when `POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID` are present, with `sourcemaps: { enabled: true, releaseName: "farmsmart-dashboard", releaseVersion: process.env.DEPLOY_SHA ?? "local", deleteAfterUpload: true }`. Set `build.sourcemap: "hidden"` so maps are generated for upload but not linked in the shipped bundle (the public bundle must not expose them). The plugin is a no-op locally without credentials.

- [ ] **Step 3: Wire build-time secrets in deploy workflows.** In both `deploy-staging.yml` and `deploy-production.yml`, add `POSTHOG_CLI_API_KEY` (personal API key, `error tracking write` + `organization read` scopes), `POSTHOG_CLI_PROJECT_ID`, and `POSTHOG_CLI_HOST: https://us.posthog.com` from the respective GitHub environment secrets, exposed to the `pnpm --filter ... run build` step. Set `DEPLOY_SHA` (already resolved by the workflow) in the build env so the release version is the exact promoted SHA. The production workflow must fail the build if `POSTHOG_CLI_API_KEY` is present-but-empty (guard against silent symbolication gaps); staging may warn and continue.

- [ ] **Step 4: Verify staging symbolication end to end.** After a staging deploy at a known SHA, trigger the synthetic staging exception from Task 13 Step 1 (or a temporary route), open the resulting PostHog issue, and confirm: the stack trace resolves to a real file path and line number in the deployed bundle, and the release chip shows `farmsmart-api@<short-sha>` / `farmsmart-dashboard@<short-sha>` matching the promoted SHA. Capture screenshots or JSON of the resolved frame as evidence.

- [ ] **Step 5: Run validation and commit.**

```bash
pnpm run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/admin-dashboard run build
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
git add artifacts/api-server/build.mjs artifacts/api-server/package.json artifacts/admin-dashboard/vite.config.ts artifacts/admin-dashboard/package.json .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml render.yaml
git commit -m "feat(obs): upload source maps and tag api/dashboard releases by SHA"
```

### Task 13: Enable PostHog Self-driving (Error Tracking signal source only)

**Files:**

- Modify: `docs/runbooks/incident-response.md`
- Create: `docs/runbooks/posthog-self-driving.md`

**Consumes:** Tasks 11-12 verified in staging — real exceptions arriving, grouped, and symbolicated against the deployed SHA.

- [ ] **Step 1: Connect the repository.** In the existing US PostHog project, connect `github.com/ShubhamKr07/farmsmart` via the Self-driving setup. Enable the **Error Tracking** signal source only. Leave Replay, UX friction, Logs, and all external sources (Sentry, Zendesk, Linear, etc.) off. Confirm AI data processing consent is enabled at the org level (required for Self-driving).

- [ ] **Step 2: Verify one synthetic staging exception becomes one draft PR.** Inject a single synthetic, clearly-labeled exception into staging API (e.g. a temporary `/api/_posthog_synthetic` route behind `NODE_ENV != production` that throws a typed `SyntheticPostHogProbeError`). Confirm in the PostHog inbox: one signal arrives, it groups into one report, the research agent marks it **Actionable**, and an implementation agent opens exactly one draft PR. The PR must: be a draft, target a `ai-fix/*` branch (not `main`), link the PostHog report, include a root-cause explanation, and include a regression test. Confirm the PR triggers the required `CI` workflow and cannot be merged while CI is red or while it remains a draft.

- [ ] **Step 3: Confirm guardrails hold.** Verify the agent: cannot push to `main` (branch protection), cannot auto-merge, cannot trigger a staging or production deploy (those workflows require `workflow_run` from CI on `main`, which a draft PR is not), and does not touch migrations, `render.yaml`, auth, or secrets in its diff. Record the observed limitations in `docs/runbooks/posthog-self-driving.md`.

- [ ] **Step 4: Document spend control and disable path.** `docs/runbooks/posthog-self-driving.md` records: the $15/PR pricing (first three free each month), how to set a monthly spend limit, how to pause new PRs (toggle the Error Tracking signal source off in the inbox — open reports/PRs are preserved), how to fully revoke agent access (disconnect the GitHub integration), and the explicit statement that pausing Self-driving never disables error capture or Better Stack.

- [ ] **Step 5: Remove the synthetic probe and commit docs.**

```bash
git add docs/runbooks/incident-response.md docs/runbooks/posthog-self-driving.md
git commit -m "docs(obs): enable PostHog self-driving error-tracking source"
```

### Task 14: Add daily PostHog + PR digest over SMTP

**Files:**

- Create: `scripts/ci/report-posthog-errors.mjs`
- Create: `scripts/ci/report-posthog-errors.test.mjs`
- Create: `.github/workflows/posthog-daily-report.yml`
- Modify: `scripts/package.json` (add `nodemailer` dep + `test:posthog-report` script)
- Modify: `pnpm-lock.yaml`

**Consumes:** Tasks 11-13 (real grouped issues exist) and the PostHog personal API key (read scope).

- [ ] **Step 1: Write the report script with failing test first.** `report-posthog-errors.test.mjs` stubs the PostHog API (returns two fake issues, one open PR) and the SMTP transport, runs the script, and asserts: the rendered email body contains issue titles, occurrence counts, affected-user counts, `service`, `environment`, `release`, links to the PostHog reports, links to the open Self-driving PRs, and a CI/pending-review summary; and that the body contains **no** exception payload, stack trace, PII, or raw user UUID. Assert the script exits 0 even when PostHog returns zero issues (empty-but-valid report).

- [ ] **Step 2: Implement the report script.** `report-posthog-errors.mjs` queries the PostHog private API (`https://us.posthog.com/api/projects/:id/error_tracking/` endpoints) for issues with `first_seen` or `last_seen` in the last 24h, filtered by `environment` and `service`. For each issue it captures: title, occurrence count, unique-user count, `service`, `environment`, `release`, and the PostHog URL. It then queries the GitHub API (`gh pr list --search "author:app/posthog is:open" --json ...`) for open Self-driving PRs and their CI status. It renders both plain-text and minimal HTML, and sends via Nodemailer over SMTP (`host`, `port`, `user`, `pass`, `from`, `to` from env). All HTTP/SMTP failures are caught and logged; the script never raises into the workflow step failure path except on missing required env (fail-fast on misconfiguration, never silent skip).

- [ ] **Step 3: Add the scheduled workflow.** `.github/workflows/posthog-daily-report.yml` runs on `schedule: - cron: "0 12 * * *"` and `- cron: "0 13 * * *"` (covering EST 08:00 and EDT 08:00 year-round — America/New_York is UTC-5 in winter, UTC-4 in summer; GitHub cron is UTC-only and does not track DST, so both fire daily and the script suppresses the off-by-one duplicate), plus `workflow_dispatch` for manual test delivery. The job uses a dedicated `observability` GitHub environment with **no** deploy credentials. Env: `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST: https://us.posthog.com`, `POSTHOG_SMTP_HOST/PORT/USER/PASS`, `POSTHOG_SMTP_FROM`, `POSTHOG_SMTP_TO`. Permissions: `contents: read`, `pull-requests: read`, `actions: read` — nothing else.

- [ ] **Step 4: Suppress the DST duplicate inside the script.** At the top of the script, compute `new Date()` in `America/New_York`; if the local hour is not `8`, exit 0 without sending. This makes exactly one of the two daily cron fires deliver a report year-round.

- [ ] **Step 5: Test delivery and commit.** Trigger `workflow_dispatch` on a staging-configured recipient; confirm the email arrives, renders correctly, and contains zero exception payloads. Then commit.

```bash
node --test scripts/ci/report-posthog-errors.test.mjs
git add scripts/ci/report-posthog-errors.mjs scripts/ci/report-posthog-errors.test.mjs .github/workflows/posthog-daily-report.yml scripts/package.json pnpm-lock.yaml
git commit -m "feat(obs): daily PostHog error + PR digest over SMTP"
```

### Task 15: Mobile JS exception capture and Hermes source maps (follow-up)

**Files:**

- Create: `artifacts/farmeasy/lib/posthog.ts`
- Modify: `artifacts/farmeasy/app/_layout.tsx`
- Modify: `artifacts/farmeasy/components/ErrorBoundary.tsx`
- Modify: `artifacts/farmeasy/metro.config.js`
- Modify: `artifacts/farmeasy/app.json`
- Modify: `artifacts/farmeasy/eas.json`
- Modify: `artifacts/farmeasy/package.json`, `pnpm-lock.yaml`

**Consumes:** Tasks 11-14 stable in production for at least one release cycle. This task ships with the **next planned EAS build** — it is not on the production-promotion critical path of the server/web tasks because adding `posthog-react-native` and its Expo peers introduces native modules requiring a new native build, not an OTA-only update.

- [ ] **Step 1: Install the SDK and Expo peers.** `npx expo install posthog-react-native expo-file-system expo-application expo-device expo-localization`. This adds native modules → requires a new EAS Build, not just `eas update`. Confirm the build still produces a valid `production` channel build before proceeding.

- [ ] **Step 2: Add the client module.** `artifacts/farmeasy/lib/posthog.ts` initializes `PostHog` with `EXPO_PUBLIC_POSTHOG_KEY`/`EXPO_PUBLIC_POSTHOG_HOST`, `autocapture: { captureScreens: false, captureTouches: false }` (no screen/touch analytics in this release), `enableSessionReplay: false`, `errorTracking: { autocapture: { uncaughtExceptions: true, unhandledRejections: true, console: [], nativeCrashes: false } }` (JS exceptions only; native crashes stay off — no `@posthog/react-native-plugin`, no dSYM/ProGuard upload in this release). Tag every event with `environment`, `service: "mobile"`, `release`, `app_version`.

- [ ] **Step 3: Wire the provider and error boundary.** In `app/_layout.tsx`, wrap with `<PostHogProvider client={posthog}>`. In `components/ErrorBoundary.tsx`, call `posthog.captureException(error, { componentStack })` in `componentDidCatch` **in addition to** the existing `onError` prop — the existing user-facing `ErrorFallback` UX stays unchanged. Do not enable console capture (would double-count React render errors alongside the boundary).

- [ ] **Step 4: Hermes source maps.** In `metro.config.js`, switch to `getPostHogExpoConfig(__dirname)` from `posthog-react-native/metro`. Add `"posthog-react-native/expo"` to `app.json` `expo.plugins` with `{ "skipOnConflict": true }` (handles JS source-map upload on native builds; OTA updates need a manual `posthog-cli hermes upload --directory dist` after `eas update`, documented in the runbook). Set `POSTHOG_CLI_API_KEY`/`POSTHOG_CLI_PROJECT_ID` in the EAS build environment (EAS secrets, not in the repo).

- [ ] **Step 5: Build, verify, commit.** Run a `production` EAS Build; confirm the build uploads Hermes source maps to PostHog. Trigger a synthetic JS exception on the preview build; confirm it groups into one issue with a symbolicated stack trace. Then commit.

```bash
git add artifacts/farmeasy/lib/posthog.ts artifacts/farmeasy/app/_layout.tsx artifacts/farmeasy/components/ErrorBoundary.tsx artifacts/farmeasy/metro.config.js artifacts/farmeasy/app.json artifacts/farmeasy/eas.json artifacts/farmeasy/package.json pnpm-lock.yaml
git commit -m "feat(obs): mobile JS exception capture and Hermes source maps"
```

## Release 4 Verification Gate

```bash
pnpm run typecheck
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run build
test -f artifacts/api-server/dist/jobs/overdueScan.mjs
uv run --directory artifacts/recommender-svc pytest -v
node --test scripts/ci/report-posthog-errors.test.mjs
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
- PostHog canary tests pass: `$exception` events from API, dashboard, and recommender carry `environment`/`service`/`release`/`request_id`/`error_type` and contain none of the seeded sensitive canaries (JWT, internal key, raw UUID, question, answer, `ops_context`, provider payload).
- Staging stack traces symbolicate to real file:line and the release chip matches the promoted `DEPLOY_SHA` for both `farmsmart-api` and `farmsmart-dashboard`.
- One synthetic staging exception produced exactly one PostHog report and exactly one draft PR; the draft PR passed required CI and could not be merged while draft or CI-red.
- Daily SMTP digest test delivery reached the configured recipient with correct issue/PR summary and zero exception payloads.
- Removing `POSTHOG_KEY` (API/recommender) / `VITE_POSTHOG_KEY` (dashboard) at runtime disabled capture with no effect on request handling, Pino logs, Better Stack, or the deploy pipeline (fail-open verified).
- (Task 15, when shipped) Mobile preview-build JS exception grouped into one symbolicated PostHog issue; native crashes intentionally not captured.

## Rollback

- Cron cutover: set `OVERDUE_SCAN_ENABLED=false`, wait for active run to finish, then redeploy exact Task 4 `INTERVAL_FALLBACK_SHA`, which contains cycle-specific dedupe, legacy-index retirement, standalone job, and active interval scheduling. Never deploy pre-Task-2 scanner or reverse rollback order.
- Job code: redeploy last-good job SHA; additive schema remains.
- Telemetry: revert logging commit if serialization or volume causes incident; preserve runbook and native request logs.
- Better Stack: disable log drain/monitors; Render native notifications remain.
- PostHog capture: remove `POSTHOG_KEY` / `VITE_POSTHOG_KEY` / `EXPO_PUBLIC_POSTHOG_KEY` from the affected Render service(s). Capture stops immediately; app behavior is unaffected. Pino logs and Better Stack keep running.
- PostHog Self-driving: toggle the Error Tracking signal source off in the PostHog inbox to stop new draft PRs (open reports and PRs are preserved), or disconnect the GitHub integration to fully revoke agent access. Either action leaves error capture and Better Stack untouched.
- Daily digest: disable the `posthog-daily-report.yml` workflow, or remove `POSTHOG_SMTP_*` secrets from the `observability` environment. The report is read-only and sends mail only; it cannot affect production.
- Source-map uploads: safe to leave in place — uploaded maps have no runtime effect and only affect stack-trace readability in PostHog. If a release is bad, stop uploading; old symbolication remains.
- PostHog SDK integration: if the SDK itself causes a runtime regression (volume, latency, crash), revert the Task 11/15 integration commit and redeploy. Better Stack, Render metrics, and the deploy pipeline are independent and remain active throughout.
- Database migrations remain forward-only. PostHog adds no database migrations.
