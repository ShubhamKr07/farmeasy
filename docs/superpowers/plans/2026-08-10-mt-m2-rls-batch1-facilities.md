# MT-M2 Public-RLS Remediation — Batch 1: `facilities` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Enable RLS on `public.facilities` with `current_user='farmsmart_app'` backend policies (SELECT/INSERT/DELETE), and harden the app-layer boundary by adding `facilities` to the TEN-004 static tenant-scope guard (baselining its permanent bootstrap read sites) — without regressing any onboarding/wizard/demo/metrics/purge path.

**Architecture:** `facilities` is read in many bootstrap contexts before `app.org_id` exists, so a GUC-scoped policy would return 0 rows and break onboarding. The correct policy is `current_user='farmsmart_app'` (the `00010`/`00012`/`00016` precedent): it admits only the backend role and closes direct-to-Postgres access, while the app keeps self-scoping every facilities access by server-resolved `organization_id`. Since that policy gives up DB-level row isolation, we recover the safety net by making the static guard flag any *new* raw facilities access.

**Tech Stack:** Supabase hand-written SQL migration + pgTAP; `scripts/ci/check-tenant-scope.mjs`; the disposable-Supabase replay (`scripts/ci/test-disposable-supabase.sh`).

## Global Constraints

- **Prove under the real non-BYPASSRLS `farmsmart_app` role**, not a superuser. The disposable CI DB runs as `postgres` (BYPASSRLS) and never creates `farmsmart_app`, so 00020's pgTAP is **structural** (via `pg_policies`/`pg_class.relrowsecurity`), matching the `00016`–`00019` convention. Live enforcement is proven in staging/prod where the role is real.
- **No live path may regress.** The definitive gate is the full `bash scripts/ci/test-disposable-supabase.sh` run — every existing facilities/wizard/demo/metrics/purge suite must stay green with RLS enabled on `facilities`.
- **No Drizzle/schema change in this batch** — `facilities` already exists; RLS is Supabase-migration territory. `farmsmart_app` already holds table grants from the role setup.
- **Migration numbering:** latest Supabase migration is `00019`; this batch adds `00020`. Foundation pgTAP Supabase count `19 → 20`.
- Branch: `mt-m2-rls-batch1-facilities` off `origin/main`. Reversible migration; PR into `main`.

---

### Task 1: `facilities` RLS migration + structural pgTAP

**Files:**
- Create: `supabase/migrations/00020_facilities_rls.sql`
- Create: `supabase/tests/00020_facilities_rls.test.sql`
- Modify: `supabase/tests/00001_foundation.sql` (Supabase count `19 → 20`)

**Interfaces:**
- Produces: `public.facilities` has RLS enabled + 3 `farmsmart_app` backend policies (SELECT, INSERT, DELETE). Nothing else in this batch depends on new SQL objects.

- [ ] **Step 1: Write the migration.** Create `supabase/migrations/00020_facilities_rls.sql`, matching `00018`'s exact convention (lowercase, quoted policy names, `using (current_user = 'farmsmart_app')`, no `to farmsmart_app` clause — verify against `00018_organizations_backend_delete_policy.sql` and copy its style verbatim):

```sql
-- MT-M2 public-RLS remediation, Batch 1: facilities.
-- facilities shipped with NO row level security (it is read in many bootstrap
-- contexts before app.org_id/withTenantScope exists -- GET /facilities,
-- wizard org-resolution, demo getOwnerOrg, the unverified-purge sweep -- so a
-- GUC-scoped (app.org_id) policy would return 0 rows and break onboarding).
-- The correct backstop is current_user = 'farmsmart_app' (same model as
-- organizations 00010 / organization_members 00012 / invitations 00016): admit
-- only the backend role, which already self-scopes every facilities access by a
-- server-resolved organization_id WHERE (never client input; TEN-013-attested).
-- This closes direct-to-Postgres access by non-backend roles. Verbs facilities'
-- routes actually use: SELECT (facilities/wizard/demo/growthProfiles/metrics/
-- purgeUnverified), INSERT (facilities POST, demo provision), DELETE (demo
-- graduate). No UPDATE policy -- nothing updates facilities today.
-- Rollback:
--   drop policy "backend service role can select facilities" on public.facilities;
--   drop policy "backend service role can insert facilities" on public.facilities;
--   drop policy "backend service role can delete facilities" on public.facilities;
--   alter table public.facilities disable row level security;

alter table public.facilities enable row level security;

create policy "backend service role can select facilities"
  on public.facilities for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert facilities"
  on public.facilities for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete facilities"
  on public.facilities for delete
  using (current_user = 'farmsmart_app');
```

- [ ] **Step 2: Write the structural pgTAP proof.** Create `supabase/tests/00020_facilities_rls.test.sql`, modeled on `supabase/tests/00019_demo_fork_rls.test.sql` (structural, no `SET ROLE`). Assert inside `BEGIN; … ROLLBACK;` with `SELECT plan(N)`:
  - `public.facilities` has `relrowsecurity = true` (`SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.facilities'::regclass), true, '…')`);
  - exactly 3 policies exist on `public.facilities`, one each for `cmd` in (`SELECT`,`INSERT`,`DELETE`), each whose `roles`/`qual`/`with_check` reference `farmsmart_app` (query `pg_policies where schemaname='public' and tablename='facilities'`).
  End with `SELECT * FROM finish();`.

- [ ] **Step 3: Bump the foundation count.** In `supabase/tests/00001_foundation.sql`, change the `supabase_migrations.schema_migrations` assertion `19 → 20`, its message (`00001-00019` → `00001-00020`), and append a comment describing `00020` (facilities RLS + 3 farmsmart_app backend policies; current_user model because facilities is bootstrap-read).

- [ ] **Step 4: Verify via the disposable stack.**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60` (add `--ignore-health-check` to its `supabase start` locally if the CLI health-probe blocks boot — known Docker-Desktop-only issue; change nothing else).
Expected: pgTAP all files pass incl. `00001_foundation.sql` (now 32/20) and `00020_facilities_rls.test.sql`; **and the api-server suite stays green** (this is the regression proof — facilities is now RLS-enabled and every existing route path must still work under it). Report pgTAP Files/Tests + api-server pass count. Do NOT weaken assertions.

- [ ] **Step 5: Commit.**

```bash
git add supabase/migrations/00020_facilities_rls.sql supabase/tests/00020_facilities_rls.test.sql supabase/tests/00001_foundation.sql
git commit -m "feat(db): enable RLS on facilities with farmsmart_app backend policies (MT-M2 batch 1)"
```

---

### Task 2: Static-guard hardening — add `facilities` to `SCOPED_TABLES` + baseline bootstrap sites

**Files:**
- Modify: `scripts/ci/check-tenant-scope.mjs` (`SCOPED_TABLES` + `BASELINE_VIOLATIONS`)

**Interfaces:**
- Consumes: nothing from Task 1 (independent, but ships in the same PR/batch).
- Produces: `check-tenant-scope.mjs` exits 0 with `facilitiesTable` guarded; every current facilities read baselined; any *new* raw `db…from(facilitiesTable)` becomes a CI failure.

**Context:** adding `facilitiesTable` to `SCOPED_TABLES` makes the guard flag every existing `db.select()…from(facilitiesTable)` SELECT chain. These are all legitimate bootstrap reads (org/facility resolution, purge sweep) that run outside `withTenantScope` and cannot be wrapped in it — the same permanent-exception category already baselined as groups (C)/(D)/(F)/(G). The known sites (from the verb audit): `demo.ts` (getOwnerOrg/status), `facilities.ts` (membership + GET /facilities), `wizard.ts` (facility validation ×2), `metrics.ts` (timezone), `growthProfiles.ts` (pilot), `lib/purgeUnverified.ts` (sweep). (`insert`/`delete` sites use `db.insert(facilitiesTable)` / `tx.delete(facilitiesTable)` — the table is the verb arg, not a `.from/.into/.table(...)` chain, so the regex does not match them; only SELECT `.from(facilitiesTable)` chains trip.)

- [ ] **Step 1: Add `facilitiesTable` to `SCOPED_TABLES`.** In `scripts/ci/check-tenant-scope.mjs`, append `"facilitiesTable",` to the `SCOPED_TABLES` array.

- [ ] **Step 2: Enumerate what now trips.**

Run: `node scripts/ci/check-tenant-scope.mjs`
Expected: FAIL listing the facilities SELECT sites as new violations, each as `path:line: <trimmed start line>`. Copy the exact `relPath::<trimmed start line>` keys it prints (the trimmed start line is the `const … = await db` / single-line `const … = await db.select(...)` line the chain begins on).

- [ ] **Step 3: Baseline them as a permanent (H) group.** In `BASELINE_VIOLATIONS`, add a labeled block using the EXACT keys Step 2 printed (do not hand-guess the trimmed text — paste what the guard reports):

```js
  // --- (H) MT-M2 batch 1: facilities is now a SCOPED_TABLES entry (its RLS is a
  //         current_user backend backstop, so the static guard is the row-level
  //         safety net). These are PERMANENT bootstrap-read exceptions, same
  //         category as (C)/(D)/(F)/(G): each resolves or validates a facility/
  //         org before any tenant GUC exists (or is a scheduled sweep), and each
  //         already carries its own explicit organization_id/id WHERE. A NEW
  //         un-scoped facilities read is NOT baselined and will fail this gate.
  "artifacts/api-server/src/routes/demo.ts::<exact key from guard>",
  "artifacts/api-server/src/routes/facilities.ts::<exact key from guard>",
  // …one line per site the guard reported (demo ×N, facilities ×N, wizard ×2,
  //   metrics, growthProfiles, lib/purgeUnverified)…
```

- [ ] **Step 4: Confirm the guard is clean.**

Run: `node scripts/ci/check-tenant-scope.mjs`
Expected: exit 0, `check-tenant-scope: clean (13 scoped tables checked, 0 new violations, N known baseline items …)`.

- [ ] **Step 5: Sanity — the guard still catches a NEW stray read.** Temporarily add a throwaway `const _x = await db.select().from(facilitiesTable);` to any routes file, run the guard, confirm it FAILS on that new line (not baselined), then remove the throwaway. (Proves the safety net is live.)

- [ ] **Step 6: Commit.**

```bash
git add scripts/ci/check-tenant-scope.mjs
git commit -m "feat(ci): guard facilities in check-tenant-scope; baseline its bootstrap reads (MT-M2 batch 1)"
```

---

### Task 3: Whole-batch verification + PR

- [ ] **Step 1: Full disposable-stack proof (definitive).**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -80`
Expected: pgTAP green (incl. `00020` + foundation 32/20); api-server suite green (no regression from facilities RLS); report the counts.

- [ ] **Step 2: Typecheck.**

Run: `pnpm run typecheck`
Expected: PASS (no code changed, but confirm).

- [ ] **Step 3: Push + open PR into `main`.**

```bash
git push -u origin mt-m2-rls-batch1-facilities
```
Then open a PR titled `feat: enable RLS on facilities + static-guard hardening (MT-M2 RLS batch 1)`, body summarizing: the current_user-vs-GUC decision + rationale (bootstrap reads), the 3 policies, the SCOPED_TABLES mitigation, and the regression proof (api-server suite green under facilities RLS). CI's `database-integration` job is the gate.

- [ ] **Step 4: Security-compliance attestation.** Before merge, security-compliance-engineer reviews `00020` + the `current_user` choice + confirms no live path regressed and no new cross-tenant exposure (facilities was previously ungated entirely, so this is strictly additive). ATTEST required to merge.

## Rollback

Single migration: `drop policy … ×3; alter table public.facilities disable row level security;`. The `check-tenant-scope.mjs` change is additive (revert by removing the `SCOPED_TABLES` entry + the (H) baseline block). No schema/data change to reverse.

## Self-review

- Spec coverage: Batch 1's policy model (current_user), migration, pgTAP, the folded-in SCOPED_TABLES mitigation, regression proof — all mapped to Tasks 1–3.
- No GUC-scoped facilities policy (would break bootstrap reads — the whole reason for this design).
- pgTAP is structural (disposable DB has no farmsmart_app role) — consistent with 00016–00019.
- Batches 2–4 (layout/crops/sensor_status) are out of this plan; authored just-in-time.
