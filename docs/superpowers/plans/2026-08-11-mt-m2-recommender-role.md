# MT-M2 — Recommender tenant-scoped read role (task #5) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Move the recommender off `postgres`/BYPASSRLS to a dedicated non-BYPASSRLS `farmsmart_recommender` role that grounds only on the querying user's own tenant + global reference, and give `recommender_cache`/`recommender_queries` RLS (closing task #4's last gap).

**Spec:** `docs/superpowers/specs/2026-08-11-mt-m2-recommender-tenant-scoped-role-design.md`.

## Global Constraints
- **Policies use `current_user = 'farmsmart_recommender'` (string predicate), NOT `TO farmsmart_recommender`** — a `TO role` clause requires the role to exist, which it doesn't in the disposable CI DB; the `current_user=` string form is why the whole codebase's backend policies work in CI (structural) + apply in prod. Match `00020`/`00007` conventions.
- **Recommender GUC-scoped reads rely on `00007`'s role-agnostic policies** (verified: bare `using (… = current_setting('app.…'))`, no `TO`) — so `farmsmart_recommender` is scoped for free on `growth_profiles`/`cycles` once it sets the GUC. It only needs SELECT **grants** on those tables.
- **Prove under the real non-BYPASSRLS role** where the disposable CI allows (structural pgTAP for the role-string policies; isolation proven functionally via the api-server/recommender path + staging).
- **BUILD SEQUENCING: this task lands AFTER RLS Batches 2 (`bad_tray_entries`) + 3 (`crops`) merge** — the recommender reads both, and their policies must admit the recommender role (Task 2 handles `bad_tray_entries`; confirm Batch 3's `crops` SELECT policy is role-agnostic so the recommender's GUC scopes it). Migration number = next free after Batches 2+3 (likely `00023`+); pin at build time. Foundation Supabase count bumps accordingly.
- **The role password + `DATABASE_URL` secret swap is the USER's action** (Claude never handles it). Claude writes the runbook + DDL + verify workflow.
- Branch `mt-m2-recommender-role` off `main` (rebase onto Batches 2+3 once merged).

---

### Task 1: `farmsmart_recommender` role — runbook, grants DDL, verify workflow
**Files:** Create `docs/runbooks/recommender-rls-role-rotation.md`; modify `.github/workflows/verify-prod-db-role.yml` (or add a recommender variant).
**Owner:** devsecops + backend-rls; security-compliance reviews.

- [ ] **Step 1: Read-table audit** for the grant list — grep `artifacts/recommender-svc/app` for every table `farm_context.py`/`cache_repo.py`/`embed_upsert.py`/`query_log.py`/`ingest.py` touch. Record the exact set (expected: `crops`, `growth_profiles`, `cycles`, `bad_tray_entries`, `recommender_cache`, `recommender_queries`; verify).
- [ ] **Step 2: Write the runbook** `docs/runbooks/recommender-rls-role-rotation.md` mirroring `docs/runbooks/prod-rls-role-rotation.md`: the SQL for the user to run in the Supabase SQL editor —
  ```sql
  create role farmsmart_recommender with login password '<generated, store only in Render env>';
  grant usage on schema public to farmsmart_recommender;
  grant select on public.crops, public.growth_profiles, public.cycles, public.bad_tray_entries to farmsmart_recommender;
  grant select, insert on public.recommender_cache, public.recommender_queries to farmsmart_recommender;
  grant usage, select on all sequences in schema public to farmsmart_recommender;  -- for the two insert tables' serials
  -- NO write grants on tenant tables. NOT BYPASSRLS.
  ```
  Plus: swap `farmsmart-recommender`'s `DATABASE_URL` to the new role (transaction pooler, `sslmode=require`); keep `DATABASE_URL_DIRECT` (dlt) as-is unless the audit says otherwise; verification + rollback (revert `DATABASE_URL` to prior role); blast-radius warning (lockstep with any password reset). Staging first, then prod.
- [ ] **Step 3: Extend `verify-db-role`** to assert the recommender runtime role is non-BYPASSRLS (a `PRODUCTION_RECOMMENDER_DATABASE_URL` production secret + a job/arg asserting `rolbypassrls=false` for `farmsmart_recommender`), reusing `scripts/ci/verify-db-role.mjs`.
- [ ] **Step 4: Commit.** `docs+ci: farmsmart_recommender role rotation runbook + verify (task #5)`.

---

### Task 2: RLS on `recommender_cache`, `recommender_queries`, + `bad_tray_entries` recommender-read policy
**Files:** Create `supabase/migrations/000NN_recommender_rls.sql` (NN = next free after Batches 2+3), `supabase/tests/000NN_recommender_rls.test.sql`; modify `supabase/tests/00001_foundation.sql` (bump).
**Owner:** backend-rls; security-compliance attests.

- [ ] **Step 1: Write the migration.**
  - `recommender_cache` (global cache, not tenant data): `enable row level security` + `current_user in ('farmsmart_recommender','farmsmart_app')` SELECT + INSERT policies (recommender writes/reads; api-server may read).
  - `recommender_queries` (per-user log): `enable row level security` + `current_user = 'farmsmart_recommender'` SELECT + INSERT policies (the recommender writes keyed on `user_id`; DB-level scoping is the backend role, app scopes by `user_id` — the recommender path has no `auth.uid()`).
  - `bad_tray_entries`: add a `current_user = 'farmsmart_recommender'` SELECT policy (its Batch 2 policy is `current_user='farmsmart_app'`, which doesn't admit the recommender). Unscoped at the row level is acceptable — `farm_context.py` reads it only via `JOIN cycles`, and `cycles`' `00007` facility-GUC policy provides the tenant scoping. **Decision: option (a) from the spec (add the policy), not (b) drop** — keeps own-farm bad-tray grounding.
  - Header comment: the model + rollback (drop policies + disable RLS on the two + drop the bad_tray recommender policy).
- [ ] **Step 2: pgTAP** `000NN_recommender_rls.test.sql` — structural: RLS enabled on `recommender_cache`/`recommender_queries`; expected policies present with correct cmd + `farmsmart_recommender` predicate; `bad_tray_entries` now has both a `farmsmart_app` and a `farmsmart_recommender` SELECT policy.
- [ ] **Step 3: Foundation bump** (+1 Supabase migration).
- [ ] **Step 4: Verify** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60` — pgTAP green; api-server suite green. Commit `feat(db): RLS on recommender_cache/queries + bad_tray recommender read policy (task #5)`.

---

### Task 3: Tenant-context plumbing (api-server → recommender)
**Files:** modify `artifacts/recommender-svc/app/models.py`, `artifacts/api-server/src/routes/recommend.ts`; confirm `/api/recommend` tenant-gating in `app.ts`.
**Owner:** backend-rls (api-server side) + ai-python (models).

- [ ] **Step 1:** Confirm `/api/recommend` carries tenant context — check `app.ts` mount tier + that `req.tenant` is populated (needs `X-Facility-Id`). If it's not tenant-gated today, add `requireTenantContext` (verify the mobile/web client sends `X-Facility-Id` on recommend calls — coordinate with frontend if not).
- [ ] **Step 2:** Add `org_id: int` + `facility_id: int` to `RecommendRequest` (recommender `models.py`).
- [ ] **Step 3:** `recommend.ts` — send `org_id`/`facility_id` from `req.tenant` in the POST body to the recommender. Update the OpenAPI/contract if the recommend request is codegen'd (check).
- [ ] **Step 4:** Typecheck; commit `feat(api): pass tenant context (org/facility) to the recommender (task #5)`.

---

### Task 4: Recommender sets the tenant GUC per request
**Files:** modify `artifacts/recommender-svc/app/db.py` (+ callers).
**Owner:** ai-python.

- [ ] **Step 1:** Add a helper (the asyncpg `withTenantScope` equivalent): acquire a pooled connection, open a transaction, `SELECT set_config('app.org_id', $1, true)` + `set_config('app.facility_id', $2, true)`, run the caller's reads in that tx. Respect `statement_cache_size=0` (already set for the pooler). 
- [ ] **Step 2:** Route `farm_context` reads (Task 5) through this helper using the request's `org_id`/`facility_id`, so `00007`'s role-agnostic policies scope them under the non-BYPASSRLS role.
- [ ] **Step 3:** Commit `feat(recommender): set tenant GUC per request for RLS-scoped reads (task #5)`.

---

### Task 5: `farm_context.py` rescope to own-tenant
**Files:** modify `artifacts/recommender-svc/app/farm_context.py`.
**Owner:** ai-python.

- [ ] **Step 1:** Run all `farm_context` reads inside the Task-4 GUC tx. `crops` → system+own (Batch 3 hybrid policy scopes it); `growth_profiles` → own org (00007); `bad_tray_entries` → own facility via the existing `JOIN cycles` (00007 scopes cycles). No query needs a manual org/facility `WHERE` if the GUC + RLS handle it — but keep the joins that establish the scope path (esp. bad_tray↔cycles).
- [ ] **Step 2:** Confirm the behavior change: bad-tray grounding is now own-farm only (accepted). Adjust any prompt text that implied fleet-wide.
- [ ] **Step 3:** Commit `feat(recommender): scope farm_context grounding to the querying tenant (task #5)`.

---

### Task 6: Isolation + regression tests
**Files:** recommender tests (`artifacts/recommender-svc/tests/…`) + an api-server/disposable-stack isolation check.
**Owner:** qa + ai-python.

- [ ] **Step 1: Isolation proof (core):** seed org A + org B with distinct growth_profiles/bad-tray data; issue a recommend as A's tenant; assert the resolved `farm_context` (and `recommender_queries.farm_context_used`) contains **only A's** rows, never B's. Run under the real `farmsmart_recommender` role (staging or a disposable stack with the role created).
- [ ] **Step 2:** `recommender_cache`/`recommender_queries` RLS proof (recommender reads/writes its own; cross-user/tenant read denied) + regression (a normal tenant recommend still returns grounded output).
- [ ] **Step 3:** Recommender's own test suite (pytest) green; `pnpm run typecheck` green for the api-server changes. Commit.

---

### Task 7: Rollout
- [ ] **Step 1:** Rebase the branch onto `main` once Batches 2+3 are merged; pin the migration number; confirm Batch 3's `crops` SELECT policy is role-agnostic (else coordinate a fix).
- [ ] **Step 2:** Full disposable-stack proof; open PR into `main`; CI `database-integration` gate. security-compliance attests (non-BYPASSRLS role, no cross-tenant grounding, no verb/role gap).
- [ ] **Step 3:** Staging: user creates the role + swaps `farmsmart-recommender`'s `DATABASE_URL`; verify isolation + a real recommend; run `verify-db-role` (non-BYPASSRLS). Then prod (SHA-gated), user secret swap, lockstep.
- [ ] **Step 4:** Confirm this unblocks **task #4** (all public tables now RLS'd) — hand off to #4.

## Rollback
Per layer: revert `DATABASE_URL` to the prior role (instant, restores service); RLS on cache/queries + the bad_tray recommender policy are additive (drop + disable); plumbing + farm_context changes revert with the code. No schema/data change (roles/policies only).
