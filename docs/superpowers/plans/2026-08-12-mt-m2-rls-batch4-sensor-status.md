# MT-M2 Public-RLS Remediation — Batch 4: `sensor_status` (facility leak-fix) — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Fix the latent cross-tenant leak in `sensor_status` (one global row, written by `cycles.ts`, read by `dashboard.ts`) by making it **per-facility** (add `facility_id`, `unique(facility_id)`), rescoping both call sites under `withTenantScope`, and adding facility-GUC RLS. Security-priority; changes runtime behavior of `cycles.ts`/`dashboard.ts`.

**Spec:** `docs/superpowers/specs/2026-08-10-mt-m2-public-rls-remediation-design.md` (Batch 4).

## Global Constraints
- **RLS is role-agnostic GUC** (`facility_id = app.facility_id`, like `00007`/`00022`) — the two call sites run under `withTenantScope` after the rescope, so the GUC scopes them; no `current_user` backstop needed.
- **The existing single global row is DELETED** in the migration (it's a regenerated aggregate snapshot, not source data — a per-facility row is re-created on the next cycle write). This makes the `facility_id NOT NULL` contract safe (no rows to violate).
- Two migrations: **Drizzle** (`facility_id` + unique) + **Supabase** (RLS). Drizzle latest `0032`; this is `0033`. Supabase: **base off #41's branch (`mt-m2-recommender-role`, has `00023`) → this is `00024`**; rebase onto `main` after #41 merges. Bump both foundation counts.
- Branch `mt-m2-rls-batch4-sensor-status` off `origin/mt-m2-recommender-role` (confirm `00023` present; rebase to main post-#41-merge). Reversible.

---

### Task 1: Drizzle migration — `facility_id` + per-facility unique
**Files:** modify `lib/db/src/schema/index.ts` (`sensorStatusTable`); create `lib/db/drizzle/0033_sensor_status_facility.sql` (+ meta); modify `supabase/tests/00001_foundation.sql` (Drizzle count 32→33).

- [ ] **Step 1:** In `sensorStatusTable`, add `facilityId: integer("facility_id").notNull().references(() => facilitiesTable.id, { onDelete: "cascade" })` + `uniqueIndex("sensor_status_facility_id_uniq").on(table.facilityId)` + an index on facility_id.
- [ ] **Step 2:** `drizzle-kit generate --name sensor_status_facility` → `0033_*.sql`. **Prepend `DELETE FROM public.sensor_status;`** to the generated SQL (clear the single global row before the NOT NULL add, so the contract holds — the generator won't know to do this). Confirm the migration order: delete → add column NOT NULL → add unique index. Add a `-- Rollback:` comment.
- [ ] **Step 3:** Foundation Drizzle count 32→33.
- [ ] **Step 4:** `pnpm --filter @workspace/db run build && pnpm run typecheck` clean. Commit `feat(db): sensor_status per-facility (facility_id + unique) (MT-M2 batch 4)`.

### Task 2: Supabase migration — facility-GUC RLS
**Files:** create `supabase/migrations/00024_sensor_status_rls.sql`, `supabase/tests/00024_sensor_status_rls.test.sql`; modify `00001_foundation.sql` (Supabase 23→24).

- [ ] **Step 1:** `00024_sensor_status_rls.sql` — `enable row level security` + role-agnostic `facility_id = nullif(current_setting('app.facility_id', true), '')::int` policies for the verbs the call sites use: SELECT (dashboard read), INSERT + UPDATE (cycles upsert). Match the `00007`/`00022` GUC idiom (no `current_user`, no `TO`). Header comment: the leak-fix rationale + rollback.
- [ ] **Step 2:** pgTAP `00024_sensor_status_rls.test.sql` — structural (RLS enabled; policies present per verb with the `app.facility_id` predicate), using `ILIKE` against pg's normalized deparse form (learned from Batch 3 — `NULLIF`/casts uppercased).
- [ ] **Step 3:** Foundation Supabase count 23→24.
- [ ] **Step 4:** Commit `feat(db): facility-GUC RLS on sensor_status (MT-M2 batch 4)`.

### Task 3: rescope `cycles.ts` + `dashboard.ts`
**Files:** modify `artifacts/api-server/src/routes/cycles.ts`, `artifacts/api-server/src/routes/dashboard.ts`; `scripts/ci/check-tenant-scope.mjs`.

- [ ] **Step 1: `cycles.ts`** — the two `sensor_status` upserts (`SELECT … LIMIT 1` → update-else-insert, ~lines 294–299/433–437) become per-facility: run under `withTenantScope(req.tenant)`, key the upsert on `facility_id = req.tenant.facilityId` (`.onConflictDoUpdate` on the new `unique(facility_id)`, stamping `facilityId`). Remove the "sensorStatusTable is out of scope" comment.
- [ ] **Step 2: `dashboard.ts`** — read `sensor_status WHERE facility_id = req.tenant.facilityId` (under `withTenantScope`), not `LIMIT 1` global.
- [ ] **Step 3:** Add `sensorStatusTable` to `check-tenant-scope.mjs` SCOPED_TABLES; if `cycles.ts`/`dashboard.ts` already use `withTenantScope` elsewhere they're whole-file-skipped — verify the guard stays clean, baseline only if a raw read remains.
- [ ] **Step 4:** `pnpm run typecheck` clean. Commit `feat(api): scope sensor_status per-facility in cycles/dashboard (MT-M2 batch 4)`.

### Task 4: isolation test + verify + PR
- [ ] **Step 1: Explicit leak test** (node:test, disposable stack): org A performs a cycle op that writes `sensor_status`; org B's `GET /dashboard` (or the sensor_status read) returns **B's own/empty, never A's values** — end-state, under the real role. Assert A's row and B's row are distinct per `facility_id`.
- [ ] **Step 2:** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -80` (`--ignore-health-check`/alt-ports as needed; don't touch un-owned containers) — pgTAP green (foundation 33/24 + `00024`), api-server suite green (no regression in cycles/dashboard), leak test passing. Report counts.
- [ ] **Step 3:** Push `mt-m2-rls-batch4-sensor-status`; PR into `main` titled `feat: facility-scope sensor_status (fix cross-tenant leak) (MT-M2 RLS batch 4)`; body = the leak + fix + isolation proof + behavior-change note (own-facility snapshot). Rebase onto main once #41 merges (pin `00024`). CI `database-integration` gate.
- [ ] **Step 4:** security-compliance attests (leak closed, per-facility isolation proven end-state, no regression to cycles/dashboard). ATTEST to merge. **This is the last RLS-enable → with #5 (#41), it unblocks task #4's invariant guard.**

## Rollback
Supabase: drop policies + disable RLS on sensor_status. Drizzle: drop `facility_id` + the unique index (reverse). Revert cycles.ts/dashboard.ts to the singleton read/write. (The deleted global row is not restored — it regenerates.)
