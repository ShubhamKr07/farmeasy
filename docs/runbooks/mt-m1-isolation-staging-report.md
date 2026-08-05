# MT-M1 Isolation Suite — Staging Run

**Date:** 2026-08-05
**Environment:** staging (`farmsmart-staging`, ref `jkxlbndnatkxmhpumvhh`), rotated to the `farmsmart_app` role per Task 13 (`BYPASSRLS: false`, confirmed via `verify-db-role.mjs`).

## Result

**11 of 11 `cross-tenant.test.ts` tests pass**, confirmed across two consecutive runs against staging (no manual reset between the two runs' assertions — only the standard fixture cleanup the suite itself performs):

```
✔ TEN-003: two facilities each independently hold a seeding room (no cross-facility conflict)
✔ GET /alerts: org B never sees org A's alert
✔ PATCH /alerts/:id: org B gets 404 for org A's alert id, not 403 or 200
✔ GET /tasks: org B never sees org A's task
✔ PATCH /tasks/:id: org B gets 404 for org A's task id
✔ GET /shipments: org B never sees org A's shipment
✔ DELETE /shipments/:id: org B gets 404 for org A's shipment id
✔ GET /inventory: org B never sees org A's item
✔ PATCH /inventory/:id: org B gets 404 for org A's item id
✔ GET /growth-profiles: org B never sees org A's growth profile
✔ GET /api/metrics: org B's dashboard totals never include org A's data

tests 11, pass 11, fail 0, cancelled 0
```

This was not a clean first pass — getting here required fixing four real, previously-undiscovered bugs, none of which were specific to this test file or to staging as an environment (all would affect production the same way once its role is rotated). Full detail in `docs/runbooks/mt-m1-rls-role-rotation.md` and the plan doc's Task 16 sections; summary:

1. Staging's schema was stale (missing the entire tenancy-scoping Drizzle migration set, `organization_members` didn't exist at all) — staging had never been migrated forward since bootstrap.
2. `public.users`, `organizations`/`wizard_progress`/`sensor_accounts`/`facility_readiness_events`/`wizard_events`, and `organization_members` (both INSERT and — critically — SELECT) had no RLS policy usable by this backend's own connection; `resolveTenantContext`'s bootstrap membership lookup was universally broken under a real non-BYPASSRLS role until fixed.
3. `00007_tenancy_rls_policies.sql`'s 11 policies threw a runtime error (`invalid input syntax for type integer: ""`) once their underlying Postgres GUC placeholder had ever been referenced on a pooled backend connection — a real hazard under Supabase's transaction-mode pooler, fixed with `NULLIF(...)`.
4. `routes/metrics.ts` never wrapped its query dispatch in `withTenantScope`, so RLS silently zeroed every dashboard metric under real enforcement — a silent wrong-answer bug, not a crash, fixed by threading a transaction handle through the metrics dispatch chain.

Also found and fixed, as test-infrastructure issues rather than app bugs: `cross-tenant.test.ts`'s own fixture-truncation logic was wiping its one-time setup between test cases, and its static route imports crashed the local no-database test run (both fixed; see commits on this branch for full detail).

## Test orgs

Created (via real `POST /facilities` calls, the actual production code path — not raw inserts): `org-a@isolation-test.example.com`, `org-b@isolation-test.example.com`. Confirmed visible in staging as real rows before cleanup (`organizations` table, ids 1 and 2, `auth.users` had both emails).

Cleaned up after confirming the run's results:
- `UPDATE users SET organization_id = NULL` for both test users first (the `users.organization_id → organizations.id` FK has no cascade, unlike every other tenant-scoped table).
- `DELETE FROM organizations WHERE name LIKE 'Org for %isolation-test.example.com%'` — 2 rows deleted, cascading to `facilities`, `organization_members`, `growth_profiles`, `accounting_connections`, `sensor_accounts`, `wizard_progress` (0 rows in all of these afterward, confirmed).
- `DELETE FROM auth.users WHERE email LIKE '%isolation-test.example.com'` — 2 rows deleted; `public.users` correspondingly back to 0 rows for these ids.

Also cleaned up unrelated manual debug-probe accounts created during this investigation (`rlsdebug@example.com`, `probe2@example.com`) — pure hygiene, not part of the isolation suite's own data.

## PRD exit criterion

**"Two test orgs fully isolated in staging; TEN-007 suite green and wired to CI" — MET.**

Two real organizations were provisioned in staging via the actual `POST /facilities` route, and all 11 cross-tenant isolation assertions (covering every MT-M1-rewired endpoint plus the TEN-003 facility-independence check) passed cleanly, twice in a row, against the rotated `farmsmart_app` role. The suite is wired into CI automatically via `run-tests.mjs`'s glob discovery (Task 14).

One item remains open and is tracked separately, not blocking this exit criterion: Task 16's test-suite isolation audit (the shared synthetic `DEFAULT_TEST_USER.sub` causing `organization_members_user_id_uniq` collisions across *other* test files when the full suite — not just this isolation suite — runs against a real, persistent database). That is a test-infrastructure robustness item, not a gap in tenant isolation itself.
