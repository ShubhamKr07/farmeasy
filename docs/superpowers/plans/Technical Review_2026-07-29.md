# FarmSmart Technical Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Review (2026-07-29):** Factual claims spot-checked against the actual codebase and confirmed accurate (`rejectUnauthorized: false` at `lib/db/src/index.ts:15`, open-by-default `CORS_ORIGIN` at `app.ts:47`, stale `clerk_user_id` naming in recommender-svc, `rangeWindowFor` at `templates.ts:151-158` is a dead ternary that always returns `""`, unlocked `setInterval` overdue scan in `index.ts`, no `.github/workflows/`, dashboard is a Render web service not a static site). This is a solid audit but **not yet a `writing-plans`-format plan**: no file:line references into existing code, no code blocks, no exact commands/values, no bite-sized TDD steps — every checkbox is a requirement statement, not something a fresh implementer subagent can execute without re-deriving the design itself. Recommend a pass through `superpowers:writing-plans` before dispatching via `subagent-driven-development`. Task-specific comments inline below.

**Goal:** Eliminate production security and correctness defects, then reduce database/API cost, deployment time, and operational risk through four independently deployable releases.

**Architecture:** API remains system-of-record. Supabase Auth owns identity; a database trigger provisions application profiles. Browser and mobile clients access operational data only through API. CI validates disposable DB plus staging deployment before production promotion.

**Tech Stack:** Supabase Postgres/Auth/Storage, Drizzle, Express, React/Vite, Expo, FastAPI, Render, GitHub Actions, pnpm, uv.

## Global Constraints

- Use forward-only migrations. Never edit applied `supabase/migrations/00001` through `00003` or Drizzle migrations `0000` through `0013`.
- Add staging Supabase and Render environments before production deployment gates.
- Runtime services use Supabase transaction pooler; migrations and dlt use session pooler.
- Each phase needs staging smoke validation, production canary, rollback instructions, and post-deploy metrics review.
- Do not add direct client access to operational tables. API remains application data boundary.

---

## Phase 1: Security And Correctness

### Task 1: Provision profiles through Supabase Auth trigger

**Files:**
- Create: `supabase/migrations/00004_auth_profile_and_rls.sql`
- Modify: `artifacts/farmeasy/app/(auth)/sign-up.tsx`
- Modify: `tests/e2e/farmeasy.spec.ts`

- [ ] Create a `SECURITY DEFINER` trigger on `auth.users` inserts that creates `public.users(id, email, role)` with the fixed `technician` role.
- [ ] Remove client-controlled role metadata and direct `supabase.from("users").insert(...)` from mobile sign-up.
- [ ] In forward migration, remove current self-insert and self-update `public.users` policies from `00002_users_rls.sql`.
- [ ] Retain only required self-profile reads; do not grant authenticated clients profile writes.
- [ ] Add E2E coverage: email/password sign-up creates a technician profile and reaches authenticated UI.
- [ ] Verify in staging that confirmation-enabled sign-ups also receive a profile before first signed-in request.

**Acceptance:** Client cannot choose or mutate role; profile creation is atomic with Auth user creation.

> **Review comment:** Task 1's own step ("verify confirmation-enabled sign-ups also receive a profile before first signed-in request") flags a real edge case, but Task 2 removes the self-insert/self-update `public.users` RLS policy in the same migration file, same phase, with no staging soak between them. If the trigger has any gap on that edge case, an affected user is left with an Auth account, no profile row, and — after Task 2 lands — no client-side path to self-heal via direct insert either. Sequence these as two migrations with a verified gap, or add an explicit staging bake period between Task 1 and Task 2 to the plan.

### Task 2: Lock down Supabase data access

**Files:**
- Modify: `supabase/migrations/00004_auth_profile_and_rls.sql`
- Reference: `lib/db/src/schema/index.ts`

- [ ] Enable RLS on every public operational table: `users`, `crops`, `growth_profiles`, `seed_lots`, `cycles`, `manual_checks`, `alerts`, `inventory_items`, `shipments`, `facilities`, `rooms`, `channels`, `racks`, `trays`, `sensor_status`, `sensors`, `sensor_readings`, `cycle_seed_lots`, `tasks`, `bad_tray_entries`, `stock_movements`, `user_settings`, `accounting_connections`, `recommender_cache`, `recommender_queries`, and `facility_logs`.
- [ ] Add no broad `anon` or `authenticated` data policies because application clients use API routes.
- [ ] Verify API server database role retains required access after RLS change.
- [ ] Add staging SQL assertions proving authenticated JWT sessions cannot select or mutate operational tables directly.

**Acceptance:** Supabase Data API cannot expose operational data with an anon or authenticated client token.

### Task 3: Harden transport and request boundaries

**Files:**
- Modify: `lib/db/src/index.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/routes/recommend.ts`
- Modify: `artifacts/api-server/src/routes/health.ts`
- Test: `artifacts/api-server/src/tests/routes/recommend.test.ts`

- [ ] Replace `ssl: { rejectUnauthorized: false }` with certificate-validated Supabase TLS configuration.
- [ ] Fail production startup when `CORS_ORIGIN` is absent; retain permissive CORS only for explicit development mode.
- [ ] Reduce global JSON size limit and set route-specific limits for uploads and recommender requests.
- [ ] Add `express-rate-limit` policy for recommender calls by authenticated user and IP.
- [ ] Reject blank or oversized recommender questions before dashboard or upstream work begins.
- [ ] Use `AbortSignal.timeout()` for recommender proxy requests and return a bounded timeout response.
- [ ] Change readiness health endpoint to issue a bounded DB query.

**Acceptance:** API does not accept unrestricted cross-origin, oversized, unlimited, or indefinitely hanging recommendation requests.

### Task 4: Correct production defects and validate inputs

**Files:**
- Modify: `artifacts/recommender-svc/app/query_log.py`
- Modify: `artifacts/recommender-svc/app/models.py`
- Modify: `artifacts/api-server/src/routes/tasks.ts`
- Modify: `artifacts/api-server/src/routes/shipments.ts`
- Modify: `artifacts/api-server/src/routes/inventory.ts`
- Create: `artifacts/api-server/src/tests/routes/tasks.test.ts`
- Create: `artifacts/api-server/src/tests/routes/shipments.test.ts`
- Create: `artifacts/api-server/src/tests/routes/inventory.test.ts`
- Create: `artifacts/recommender-svc/tests/test_query_log.py`

- [ ] Rename recommender audit insert target from `clerk_user_id` to `user_id` and use consistent API/recommender request naming.
- [ ] Apply `completedAt IS NULL` only when task status filter is absent.
- [ ] Build shipment predicates in SQL before keyset cursor and `LIMIT`.
- [ ] Validate inventory numeric values as finite, non-negative values; validate dates and enumerated fields before persistence.
- [ ] Add regression tests for recommender logging, done-task lookup, filtered multipage shipments, and invalid inventory payloads.

**Acceptance:** These paths return expected records and 400-level validation failures instead of database-driven 500 responses.

### Task 5: Protect media and remove stale auth tests

**Files:**
- Create: `supabase/migrations/00005_private_media_storage.sql`
- Modify: `artifacts/api-server/src/routes/media.ts`
- Modify: `tests/e2e/farmeasy.spec.ts`
- Modify: `tests/playwright.config.ts`

- [ ] Migrate media bucket to private access without deleting existing objects.
- [ ] Return short-lived signed media URLs from API rather than public object URLs.
- [ ] Remove committed Clerk test credentials and MFA handling.
- [ ] Use staging Supabase test-user credentials supplied only through CI secrets.

**Acceptance:** Media is not anonymously accessible; E2E covers current Supabase Auth, not removed Clerk behavior.

> **Review comment:** This reverses a deliberate, recently-shipped, already-reviewed design decision, not an oversight. The current `media` bucket (`supabase/migrations/00003_media_storage_bucket.sql`) is public-read/no-RLS on purpose — documented rationale in the migration's own comment, confirmed sound by a final whole-branch code review. Anonymous read access to user-uploaded photos is a legitimate privacy concern worth fixing, but this task should say explicitly "this intentionally reverses migration 00003's design" and get a human decision, not read as a routine hardening item alongside the rest of Phase 1.

## Phase 2: Performance And Scalability

### Task 6: Extract and bound dashboard computation

**Files:**
- Create: `artifacts/api-server/src/services/dashboardSnapshot.ts`
- Modify: `artifacts/api-server/src/routes/dashboard.ts`
- Modify: `artifacts/api-server/src/routes/recommend.ts`
- Create: `artifacts/api-server/src/tests/services/dashboardSnapshot.test.ts`

- [ ] Move `computeDashboardSnapshot` out of HTTP route module.
- [ ] Replace completed-cycle, waste, bad-tray, and alert in-memory aggregations with SQL aggregates bounded by reporting windows.
- [ ] Keep route layer limited to authentication, service invocation, response mapping, and error logging.
- [ ] Make recommender import the dashboard service rather than `routes/dashboard.ts`.
- [ ] Add fixtures containing records outside reporting windows and assert exclusion.

**Acceptance:** Dashboard response cost scales with requested reporting window, not total retained history.

> **Review comment:** Task 9 also touches dashboard-adjacent frontend code (`App.tsx`, `AppLayout.tsx`, `TierBMetricCard.tsx`) with no ordering dependency declared against this task. If Task 9's lazy-loading/panel-mounting changes land first, they'll be built against the current route-embedded `computeDashboardSnapshot`; if Task 6 lands first, Task 9 is fine. Either order probably works, but the plan should say so explicitly instead of leaving it implicit — "independently deployable" is asserted at the phase level but not verified at the task level here.

### Task 7: Repair metrics range semantics

**Files:**
- Modify: `artifacts/api-server/src/lib/metrics/templates.ts`
- Modify: `artifacts/api-server/src/tests/metrics/metrics.test.ts`
- Modify: `artifacts/api-server/src/tests/metrics/fixtures/seed.sql`

- [ ] Replace always-empty `rangeWindowFor` with template date-column mappings and parameterized bounds.
- [ ] Include explicit timestamp range in time-bucket joins before `date_trunc` grouping.
- [ ] Add test data older than 90 days and assert 7d, 30d, 90d, and all-time outputs differ correctly.
- [ ] Run staging `EXPLAIN ANALYZE` for representative sensor and cycle metrics.

**Acceptance:** Range controls affect scalar, grouped, and time-series metric results; historical scans are bounded.

### Task 8: Paginate and optimize operational history

**Files:**
- Create: `lib/db/drizzle/0014_query_performance_indexes.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `artifacts/api-server/src/routes/sensor-readings.ts`
- Modify: `artifacts/api-server/src/routes/alerts.ts`
- Modify: `artifacts/api-server/src/routes/badTrays.ts`
- Modify: `artifacts/api-server/src/routes/layout.ts`

- [ ] Add `(sensor_id, read_at DESC)` index.
- [ ] Add validated keyset pagination to sensor history.
- [ ] Apply validated SQL `LIMIT` to alerts before formatting rows.
- [ ] Separate bounded bad-tray detail pages from SQL-derived summary aggregates.
- [ ] Build facility hierarchy from parent-ID maps instead of repeated nested array filtering.
- [ ] Replace sequential tray deletion with one transaction and set-based deletion.

**Acceptance:** No history route creates unbounded payloads or N-round-trip layout mutations.

### Task 9: Reduce client and recommender waste

**Files:**
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Modify: `artifacts/admin-dashboard/src/components/layout/AppLayout.tsx`
- Modify: `artifacts/admin-dashboard/src/components/metrics/TierBMetricCard.tsx`
- Modify: `artifacts/recommender-svc/app/embed_upsert.py`
- Create: next Drizzle migration after Task 8 for unique `recommender_cache.source_url`
- Create: `artifacts/recommender-svc/tests/test_embed_upsert.py`

- [ ] Lazy-load dashboard routes and panels.
- [ ] Mount panel content only while that panel is open.
- [ ] Batch selected metric keys into one metrics request per tab/range.
- [ ] Add unique source URL constraint and replace check-then-insert with upsert.
- [ ] Bound embedding concurrency and coordinate equivalent concurrent cache misses.

**Acceptance:** Closed panels perform no data fetches; identical cache misses do not duplicate paid ingestion or embeddings.

> **Review comment:** Bundles three unrelated concerns in one task — frontend lazy-loading/panel-mounting (TypeScript/React), a Drizzle migration adding a unique constraint, and Python embedding-concurrency changes in recommender-svc. None of these three share a file, a test suite, or a failure mode. A reviewer could approve the frontend change and reject the embedding-concurrency change, but the task is structured so both ship or neither does. Split into 2-3 tasks along those language/concern boundaries.

## Phase 3: Delivery Safety And Cost

### Task 10: Build CI and staging validation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-staging.yml`
- Create: `.github/dependabot.yml`
- Modify: `package.json`
- Modify: `artifacts/api-server/src/tests/metrics/metrics.test.ts`

- [ ] Run frozen pnpm install, codegen drift check, workspace typecheck, API tests, mobile tests, recommender pytest, and production dependency audit.
- [ ] Provision disposable CI database; make metrics tests fail when database setup is absent.
- [ ] Apply Drizzle and Supabase migrations to staging before smoke tests.
- [ ] Deploy staging services, run Playwright against staging, and upload failure traces/screenshots.
- [ ] Add grouped dependency update PRs.

**Acceptance:** No critical suite silently skips; production promotion requires green CI and staging smoke tests.

### Task 11: Reduce Render cost and deployment blast radius

**Files:**
- Modify: `render.yaml`
- Modify: `DEPLOY.md`
- Create: `docs/runbooks/staging-and-production-deploy.md`

- [ ] Provision staging API, dashboard, recommender, and Supabase environments.
- [ ] Add service build filters including each service path and required shared libraries.
- [ ] Convert dashboard from Vite preview web service to Render Static Site using `dist/public` and SPA fallback.
- [ ] Convert recommender from public web service to private service.
- [ ] Replace public recommender URL with private Render DNS in API configuration.
- [ ] Document secret promotion, rollback, environment drift checks, and release order.

**Acceptance:** Dashboard is CDN-served, recommender has no public ingress, and unrelated changes do not rebuild every service.

## Phase 4: Operational Hardening

### Task 12: Isolate scheduled work and add observability

**Files:**
- Modify: `artifacts/api-server/src/index.ts`
- Create: `artifacts/api-server/src/jobs/overdueScan.ts`
- Modify: `render.yaml`
- Modify: `artifacts/recommender-svc/app/main.py`
- Create: `docs/runbooks/incident-response.md`

- [ ] Remove API startup and interval overdue scans.
- [ ] Run overdue scanning from singleton Render cron/worker with advisory or distributed lock.
- [ ] Move recommender cache warming/refresh from request path to scheduled work.
- [ ] Emit structured metrics for recommender timeout, rate limit, provider cost, cache hit rate, dashboard query duration, DB pool saturation, and readiness failures.
- [ ] Add alert thresholds, rollback procedure, and incident diagnostics.

**Acceptance:** API replica count does not duplicate scheduled work; provider failures cannot exhaust request capacity; operators can identify latency, database, cache, and cost regressions.

## Release Gates

1. **Phase 1:** Database backup, role-escalation test, API/mobile auth smoke test, secret rotation.
2. **Phase 2:** Staging `EXPLAIN ANALYZE`, dashboard latency baseline comparison, response-contract regression checks.
3. **Phase 3:** CI green, staging migrations and E2E green, static dashboard and private recommender verified.
4. **Phase 4:** One-week telemetry review, scheduler idempotency verification, rollback drill.

> **Review comment:** Global Constraints (line 16) mandates "rollback instructions" for every phase, but this section only lists validation gates (backup, smoke test, canary, telemetry review) — zero actual rollback commands or procedure for any phase. Phase 4 even lists "rollback drill" as a *gate to pass*, implying a rollback procedure should already exist by then, but none is written anywhere in the plan. Add an actual `## Rollback` subsection per phase (anchor commit/migration, revert command, verification step) before execution — the plan doesn't meet its own stated constraint yet.
