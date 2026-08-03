# MT-M0 Pilot Snapshot Rehearsal Report

**Date:** 2026-08-04
**Branch:** `multi-tenancy-mt-m0-design`
**Mechanism reused:** the disposable-Supabase rehearsal facility (`scripts/ci/test-disposable-supabase.sh`'s own approach — `supabase --workdir <dir> start`, then replay Drizzle + Supabase-managed migrations) — the same mechanism this repo already uses for the ADR-003 Supabase-cutover CI job. No separate pilot-data snapshot file exists in this repo; "pilot data" for this milestone means the schema replayed end-to-end against a live Postgres instance under Supabase's own auth/storage/RLS stack, not a restored production dump.

Rehearsal instance: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (local disposable Supabase stack at `/tmp/farmsmart-supabase`).

## Step 1-2: Migration replay

- `pnpm --filter @workspace/db run db:migrate` — **25/25 Drizzle migrations applied** (`drizzle.__drizzle_migrations` count = 25), covering the full history through this milestone's own `0017_organization_members.sql` .. `0024_seed_lots_qr_code_backfill_and_contract.sql`.
- `pnpm exec supabase db push --include-all` — **7/7 Supabase-managed migrations applied** (`supabase_migrations.schema_migrations` count = 7), through this milestone's own `00007_tenancy_rls_policies.sql`.
- Verified `relrowsecurity = t` on all 11 tables Task 8 enabled RLS on: `cycles`, `inventory_items`, `alerts`, `tasks`, `shipments`, `facility_logs`, `sensors`, `seed_lots`, `growth_profiles`, `accounting_connections`, `organization_members`.

## Step 3: Pilot labels unchanged

No pilot data snapshot exists to spot-check real QR codes against, so this is a code-inspection check per the brief's fallback. Confirmed via `git log $(git merge-base main multi-tenancy-mt-m0-design)..multi-tenancy-mt-m0-design -- <label-generation files>`: none of this milestone's 12 code tasks (Tasks 1-12) touch `artifacts/api-server/src/routes/facilities.ts` (rooms/channels label-format source) or any other label/short-ID generation path. The two facilities.ts commits present on this branch (`3b42af2`, `d83f297` — TOCTOU-race fix and transactional-creation feature) predate this milestone's own task sequence and are unrelated to it. Level-label format (`F1-C2-S4`) and seed-lot `qr_code` generation are structurally untouched by MT-M0.

## Step 4: Test suites

### pgTAP (`supabase/tests/`)

Initial run surfaced two genuine, milestone-caused fixture failures (not previously exercised against a fully-migrated instance):

1. `00001_foundation.sql` asserted `drizzle.__drizzle_migrations` has exactly **17** rows — stale from before this milestone added 8 new migrations (0017-0024). Fixed: bumped assertion to **25**.
2. `00005_private_media.test.sql` (Task 12's photo-reference backfill test) seeded `growth_profiles`, `cycles`, and two `facility_logs` rows without `organization_id`/`facility_id` — both columns went NOT NULL under this milestone (Task 4) after this test was originally written. Fixed: each insert now supplies the seeded pilot-default org/facility (`id 1`) via `(select id from organizations/facilities order by id limit 1)`, matching the same pilot-default pattern Tasks 5/6 established in the route handlers themselves.

Both fixes committed as part of this task. **Final result: `pnpm exec supabase test db` — 3/3 files, 27/27 assertions, all pass.**

### api-server test suite (full run, real DB, real Supabase auth)

Run: `CI=true REQUIRE_TEST_DATABASE=true TEST_DATABASE_URL=... DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @workspace/api-server run test`

**Result: 136 tests, 96 pass, 30 fail.** This is the first time this milestone's changes have been exercised via a full, all-files-in-one-process run (every prior task's own verification ran only its own new/touched test file in isolation) — the failures below are genuine rehearsal findings, not something any single task's review could have caught.

Two distinct root causes, confirmed by comparison (running `inventory.test.ts` alone vs. as part of the full suite):

**(a) Already-known, already-documented fallout (no new information).** Tasks 4, 5, and 6's own reports flagged 13 pre-existing files that fail `pnpm --filter @workspace/api-server run typecheck` because their fixtures/handlers predate the new NOT NULL `facility_id`/`organization_id` columns (`alerts.ts`, `badTrays.ts`, `cycles.ts`, `facilityLogs.ts`, `growthProfiles.ts`, `sensors.ts`, `shipments.ts`, `tasks.ts`, `quickbooks.ts`, `overdue-scanner.ts`, and the `inventory.test.ts`/`shipments.test.ts`/`tasks.test.ts` test files' own `seed()` helpers). Running the full suite turns those same typecheck errors into real `23502 null value in column "facility_id"/"organization_id"` runtime failures at insert time — e.g. `tasks.test.ts`'s 5 status-filter tests, `inventory.test.ts`'s PATCH-concurrency tests (confirmed via isolated single-file run: same 8 failures reproduce with zero other files present). This is the same design tradeoff every prior task explicitly deferred to MT-M1 ("record, don't fix"), now visible at runtime instead of just typecheck.

**(b) New finding: cross-suite TRUNCATE CASCADE pollution.** `run-tests.mjs` runs every `*.test.ts` file in one shared Node process, alphabetically sorted, against one shared database connection. Three files — `facilities.test.ts`, `seedLots.test.ts`, `sensors-bulk.test.ts` — include `"facilities"` (and in two cases `"organizations"`) in their own `useDatabaseFixture([...])` truncate list. Before this milestone, `TRUNCATE facilities CASCADE` had almost nothing to cascade into. Now that `facility_id` is a NOT NULL foreign key on 8 other tables (cycles, inventory_items, alerts, tasks, shipments, facility_logs, sensors, seed_lots), truncating `facilities` from any one of those three files silently cascades through all 8, deleting rows other suites depend on — including the single seeded pilot-default facility (`id 1`) that `inventory.ts`'s and `seedLots.ts`'s own route handlers resolve via `SELECT id FROM facilities ORDER BY id LIMIT 1`. `facilities.test.ts` sorts alphabetically before `inventory.test.ts`, so by the time `inventory.test.ts`'s own tests run, the pilot-default facility row may already be gone — confirmed directly: `inventory.test.ts`'s "assigns a 4-char hex itemCode on create" test **passes** when run in isolation and **fails with a 500** when run as part of the full suite. This is a genuine new regression this milestone introduced into the test *infrastructure* (not production code — nothing in a real request path truncates `facilities` mid-flight), caught for the first time by this rehearsal because no earlier task ran the full cross-file suite together. `testDatabase.ts`'s own doc comment already states the intended contract ("reference data... facilities... can survive across suites") — these three files' truncate lists violate that contract themselves; they are the fix target, not the shared helper.

Neither failure class was fixed as part of this task, consistent with every earlier task in this plan explicitly deferring cross-cutting fallout rather than expanding scope mid-task. Both are recorded here as concrete, actionable MT-M1 entry items (see below).

## Open items carried into MT-M1

1. **Task 4's 13-file typecheck/runtime fallout** (unchanged list: `alerts.ts`, `badTrays.ts`, `cycles.ts`, `facilityLogs.ts`, `growthProfiles.ts`, `sensors.ts`, `shipments.ts`, `tasks.ts`, `quickbooks.ts`, `overdue-scanner.ts`, `inventory.test.ts`, `shipments.test.ts`, `tasks.test.ts`) — these call sites need real facility/organization resolution (via `withTenantScope` once route handlers are rewired with real session context), not the pilot-default placeholder.
2. **Task 7's BYPASSRLS verification** — `scripts/ci/verify-db-role.mjs` was written but could not be run against a real staging/production connection in this session's environment (no live DB reachable outside the disposable rehearsal stack). Still needs to be run once a real non-superuser Supabase role is provisioned per `docs/runbooks/tenancy-db-role.md`.
3. **New: cross-suite TRUNCATE CASCADE pollution (found in this rehearsal).** Remove `"facilities"`/`"organizations"` from the truncate lists in `facilities.test.ts`, `seedLots.test.ts`, and `sensors-bulk.test.ts`; have those three files scope their own fixture cleanup to rows they create (e.g. by name/id) instead of truncating shared reference tables that 8 other tables now foreign-key into.

## Summary

- Migration replay: **clean** (25 Drizzle + 7 Supabase migrations, RLS confirmed enabled on all 11 scoped tables).
- Pilot label format: **unchanged** (confirmed by inspection — no MT-M0 task touches label-generation code).
- pgTAP: **clean after 2 fixture fixes** (both committed).
- api-server full suite: **not clean** — 30/136 failing, both root causes fully diagnosed and documented above, both deferred to MT-M1 by deliberate, consistent scope decision (matching this entire plan's established precedent), not silently dropped.
