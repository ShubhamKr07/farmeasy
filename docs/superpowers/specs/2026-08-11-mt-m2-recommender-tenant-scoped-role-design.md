# MT-M2 — Recommender tenant-scoped read role (task #5) — Design

**Status:** design, awaiting review. Branch `mt-m2-recommender-role-design`.
**Relates to:** task #5 (recommender read-scoped role); **unblocks task #4** (the RLS positive-invariant guard — this closes the last two no-RLS tables); **depends on** the public-RLS remediation Batches 2 (`bad_tray_entries`) + 3 (`crops`). Prior context: the recommender ran on `postgres`/BYPASSRLS (the 2026-08-09 prod incident).

## Decision (2026-08-11): tenant-scoped, non-BYPASSRLS recommender

The recommender will ground **only on the querying user's own tenant + global reference data**, NOT cross-tenant. It runs as a dedicated **non-BYPASSRLS `farmsmart_recommender`** role that sets the tenant GUC per request, so the existing role-agnostic RLS policies scope its reads. This trades the previous fleet-wide grounding for strong per-tenant isolation (chosen 2026-08-11). **Behavior change accepted:** the "bad-tray issues across all farms for a seed" grounding becomes **own-farm QA history only.**

Why non-BYPASSRLS works cleanly here: verified `00007`'s tenant policies are **role-agnostic** (bare `using (facility_id = current_setting('app.facility_id', true)::int)`, no `TO` clause), so any role with the GUC set — including `farmsmart_recommender` — is scoped by them for free. No new per-table policies needed on `growth_profiles`/`cycles`.

## Components

### 1. Role: `farmsmart_recommender` (non-BYPASSRLS, least-privilege)
- `CREATE ROLE farmsmart_recommender LOGIN PASSWORD '<generated>'` — **not** BYPASSRLS.
- Grants (least-privilege, read-mostly): `GRANT SELECT` on exactly the tables `farm_context.py` reads (`crops`, `growth_profiles`, `cycles`, `bad_tray_entries`, + any others the audit finds); `GRANT SELECT, INSERT` on `recommender_cache`; `GRANT SELECT, INSERT` on `recommender_queries`; `GRANT USAGE` on needed sequences; `GRANT authenticated` if the GUC/RLS plumbing requires it (verify). NO write grants on tenant tables.
- Rotated like `farmsmart_app`: mirror `docs/runbooks/prod-rls-role-rotation.md` (new runbook section), extend the `verify-db-role` workflow to assert `farmsmart_recommender` is **non-BYPASSRLS**, swap `DATABASE_URL` on `farmsmart-recommender` (staging then prod). **The secret swap is the user's action** (Claude never handles the password). Keep `DATABASE_URL_DIRECT` (dlt/ingestion) on its current elevated role unless the audit says otherwise.

### 2. Tenant-context plumbing
- `RecommendRequest` (recommender `models.py`) gains `org_id: int` + `facility_id: int` (currently only `user_id`).
- api-server `recommend.ts` sends them from `req.tenant` (it already resolves tenant context). `/api/recommend` must therefore be tenant-gated (carry `X-Facility-Id`); confirm its mount tier.
- The recommender sets `app.org_id` / `app.facility_id` per request via a transaction-local `set_config(...)` on its asyncpg connection (the `withTenantScope` equivalent), then runs `farm_context` reads inside that tx so `00007`'s policies scope them. Respect the transaction-pooler constraints already handled in `db.py` (`statement_cache_size=0`).

### 3. `farm_context.py` rescope (own-tenant + global reference)
- `crops` → system + own (via Batch 3's hybrid `org_id IS NULL OR = app.org_id` policy).
- `growth_profiles` → own org (existing `00007` `app.org_id` policy; role-agnostic, so the recommender GUC scopes it).
- `bad_tray_entries` → own **facility**, read via the existing `JOIN cycles` (cycles is `facility_id`-GUC-scoped by `00007`); scoping comes from the cycles join. **See the cross-batch coupling below** — `bad_tray_entries`' own policy must admit the recommender role.
- Net: `farm_context` returns only the querying tenant's rows + global/system reference. No cross-tenant grounding.

### 4. RLS on the two deferred tables (closes #4's remaining gap)
- `recommender_cache` = a **global** cache of external web-search content (not tenant data): `enable row level security` + a policy admitting `farmsmart_recommender` (and `farmsmart_app` if the api-server ever reads it) for SELECT/INSERT. Not tenant-scoped.
- `recommender_queries` = **per-user** query log (`user_id, question, answer, sources, farm_context_used`): `enable row level security` + policy scoping by the querying user. The recommender writes keyed on `user_id`; the read/scope model keys on that user. (Decide: `current_user='farmsmart_recommender'` backend policy + app-layer `user_id` scoping, vs a `user_id = auth.uid()`-style policy — the recommender path has no `auth.uid()`, so a backend-role policy + explicit `user_id` is the likely fit.)
- pgTAP for both; foundation Supabase count bumped.

## Cross-batch coupling + sequencing (important)
- **#5 sequences AFTER RLS Batches 2 + 3.** The recommender reads `bad_tray_entries` (Batch 2) and `crops` (Batch 3); their policies must **admit the `farmsmart_recommender` role**:
  - **`crops` (Batch 3)** uses `app.org_id`-GUC policies. If written role-agnostic (like `00007`), the recommender is scoped for free — ensure Batch 3's crops SELECT policy is role-agnostic (system+own).
  - **`bad_tray_entries` (Batch 2)** gets a `current_user='farmsmart_app'` policy → does NOT admit `farmsmart_recommender`. Resolve one of: (a) add a `farmsmart_recommender` SELECT policy on `bad_tray_entries` (unscoped is acceptable — the `cycles` join provides the tenant scoping via `00007`), or (b) drop `bad_tray_entries` from the recommender's grounding (own-farm bad-tray history is a minor signal). **The plan decides (a) vs (b).**
- **Unblocks #4:** once `recommender_cache` + `recommender_queries` have RLS (here) and Batches 2–4 land, every `public` base table has RLS → task #4's invariant guard can flip to enforcing.

## Testing
- **Isolation (the core proof):** a recommend request as user A's tenant grounds **only** on A's rows — assert the `farm_context_used` / the underlying reads contain no other tenant's growth_profiles/bad-tray data (seed a second org B with distinct data; confirm A's context excludes it). Run under the real `farmsmart_recommender` role.
- `recommender_cache`/`recommender_queries` RLS proof (the recommender role can read/write its own; a different tenant/user can't read another user's queries).
- Regression: `/api/recommend` still returns grounded answers for a normal tenant (own-farm context populated).
- pgTAP structural for the two new-RLS tables + `verify-db-role` asserting `farmsmart_recommender` is non-BYPASSRLS.

## Rollout / rollback
- Sequence: RLS Batch 2 + Batch 3 merged → **this task** → then #4. Staging first (role + plumbing + rescope + RLS), verify isolation + a real recommend, then prod (SHA-gated); secret swap by the user, lockstep (heed the blast-radius lesson — a role/password change staleds the recommender connection).
- Rollback: revert `DATABASE_URL` to the prior role (instant); the RLS on cache/queries is additive (drop policies + disable RLS); the `farm_context`/plumbing changes revert with the code.

## Open items for the plan
- Exact asyncpg GUC-per-request mechanics under the transaction pooler (set_config in a tx; pool acquire per request).
- `bad_tray_entries` recommender-read: policy (a) vs drop (b).
- `recommender_queries` policy model (backend-role + user_id vs auth.uid()).
- Full read-table audit for the grant list (anything `farm_context`/`cache_repo`/`embed_upsert`/`query_log` touch beyond the enumerated set).
- Whether `/api/recommend` is currently tenant-gated (needs `X-Facility-Id`); confirm mount tier + that req.tenant is available.
- `DATABASE_URL_DIRECT` (dlt ingestion) role — keep elevated or also scope.

## Out of scope (YAGNI)
- Cross-tenant / fleet-wide grounding and the anonymized-aggregate hybrid (rejected 2026-08-11).
- pgvector/embedding-model changes.
- Recommender feature changes beyond the grounding-scope shift.
