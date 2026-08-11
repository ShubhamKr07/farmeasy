# MT-M2 Public-RLS Remediation — Batch 2: the 10 `current_user` tables — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Enable RLS on the 10 backend-accessed, no-tenant-column public tables with `current_user='farmsmart_app'` per-verb backend policies (no schema change), and add them to the TEN-004 static guard — no live-path regression.

**Tables (10):** `rooms`, `channels`, `racks`, `trays`, `sensor_readings`, `bad_tray_entries`, `manual_checks`, `stock_movements`, `cycle_seed_lots`, `user_settings`.

**Architecture:** Same model as Batch 1 (facilities, `00020`) and organizations/org_members/invitations/signup: `current_user='farmsmart_app'` backend policies admit only the backend role (which self-scopes by its own `WHERE`), closing the advisor's non-backend/PostgREST threat with zero runtime risk. Option A per the rescoped spec `docs/superpowers/specs/2026-08-10-mt-m2-public-rls-remediation-design.md` (Batch 2) — denormalizing `facility_id` was explicitly rejected.

## Global Constraints
- Prove under real `farmsmart_app`; disposable-CI pgTAP is structural (no such role there) — mirror `00020_facilities_rls.test.sql` / `00016`–`00019`.
- **No schema change, no denormalization.** RLS + policies only.
- **Per-verb completeness is the top risk:** a missing policy for a verb a table's routes actually use = silent 0-row denial under the real role (invisible to BYPASSRLS CI — the class of bug behind `00012`/`00014`/`00018`). Enumerate every verb per table; add a policy for exactly those.
- Migration numbering: latest is `00020`; this is `00021`. Foundation Supabase count `20 → 21`.
- Branch `mt-m2-rls-batch2-backend-tables` off the current design branch (has main + the rescoped spec). Reversible; PR into `main`. Regression gate = full `test-disposable-supabase.sh` green.

---

### Task 1: verb audit + `00021_backend_tables_rls.sql` + pgTAP

**Files:** Create `supabase/migrations/00021_backend_tables_rls.sql`, `supabase/tests/00021_backend_tables_rls.test.sql`; modify `supabase/tests/00001_foundation.sql` (20→21).

- [ ] **Step 1: Verb audit.** For EACH of the 10 tables, grep `artifacts/api-server/src/{routes,lib}` for every `db.select/insert/update/delete` (and `tx.*` under `withTenantScope`) touching it, and record the exact set of verbs used. Expected owners (verify, don't assume): `rooms`/`channels`/`racks`/`trays` → `layout.ts` (onboarding layout create/read; likely SELECT+INSERT, maybe DELETE); `sensor_readings` → `sensor-readings.ts` (SELECT+INSERT); `bad_tray_entries` → `badTrays.ts` (SELECT+INSERT); `manual_checks` → cycles/manual-checks (SELECT+INSERT); `stock_movements` → inventory (SELECT+INSERT); `cycle_seed_lots` → cycles (INSERT+SELECT+maybe DELETE); `user_settings` → `userSettings.ts` (SELECT+INSERT/UPDATE/upsert). Record the audited verb set per table in the migration's header comment.

- [ ] **Step 2: Write the migration.** `supabase/migrations/00021_backend_tables_rls.sql` — for each table: `alter table public.<t> enable row level security;` + one `create policy … for <verb> to farmsmart_app using/with check (current_user = 'farmsmart_app')` per audited verb. Match `00020`'s exact convention verbatim (lowercase, quoted policy names, bare `current_user =` predicate, no `to farmsmart_app` role clause if `00020` omits it — copy `00020` exactly). Header comment: the model rationale (current_user, bootstrap-safe, Option A) + the per-table audited verb list + rollback (drop all policies + disable RLS on the 10).

- [ ] **Step 3: pgTAP.** `supabase/tests/00021_backend_tables_rls.test.sql`, structural (mirror `00020`'s): for each of the 10, assert `relrowsecurity=true` + a policy exists per audited verb, `farmsmart_app`-scoped. `SELECT plan(N)` exact; `BEGIN;…ROLLBACK;`.

- [ ] **Step 4: Foundation bump.** `00001_foundation.sql` supabase count `20 → 21` + message + comment describing `00021`.

- [ ] **Step 5: Verify (disposable stack).** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -80` (`--ignore-health-check` on `supabase start` locally if the probe blocks). pgTAP green incl. `00001`(now 32/21) + `00021`; **api-server suite green with ZERO regressions** — this proves no verb-gap 0-rowed a live path. Report counts. A regression here = a missing verb policy: add it, don't weaken.

- [ ] **Step 6: Commit.** `feat(db): enable RLS on 10 backend tables with current_user policies (MT-M2 batch 2)`.

---

### Task 2: add the 10 to the TEN-004 static guard

**Files:** Modify `scripts/ci/check-tenant-scope.mjs`.

- [ ] **Step 1:** Append the 10 `*Table` names (`roomsTable`, `channelsTable`, `racksTable`, `traysTable`, `sensorReadingsTable`, `badTrayEntriesTable`, `manualChecksTable`, `stockMovementsTable`, `cycleSeedLotsTable`, `userSettingsTable`) to `SCOPED_TABLES`.
- [ ] **Step 2:** `node scripts/ci/check-tenant-scope.mjs` — it FAILS listing the existing backend reads of these tables. Copy the EXACT `path::trimmed-line` keys it prints.
- [ ] **Step 3:** Baseline them as a permanent group-(I) block (paste the exact keys; comment: legitimate backend reads, same category as facilities' group-H — the `current_user` RLS + app-layer scoping is the safety net; a NEW un-scoped read still fails the gate). Note: files already using `withTenantScope` are whole-file-skipped, so only raw-`db` sites appear.
- [ ] **Step 4:** `node scripts/ci/check-tenant-scope.mjs` → exit 0, clean. Then the plan's sanity check: add a throwaway raw read of one of the 10, confirm the guard FAILS, remove it.
- [ ] **Step 5: Commit.** `feat(ci): guard the 10 batch-2 tables in check-tenant-scope; baseline their reads (MT-M2 batch 2)`.

---

### Task 3: whole-batch verification + PR
- [ ] **Step 1:** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -80` — pgTAP + api-server suite green; report counts.
- [ ] **Step 2:** `pnpm run typecheck` clean.
- [ ] **Step 3:** Push `mt-m2-rls-batch2-backend-tables`; open PR into `main` titled `feat: RLS on 10 backend tables via current_user policies (MT-M2 RLS batch 2)`; body = the Option-A rationale + the per-table audited verb list + regression proof. CI `database-integration` is the gate.
- [ ] **Step 4:** security-compliance attestation — verb-completeness enumeration (no missing-verb 0-row gap), no new cross-tenant exposure (strictly additive; these were ungated), guard baselines accurate. ATTEST to merge.

## Rollback
Drop all `00021` policies + `disable row level security` on the 10; revert the guard additions. No schema/data change.
