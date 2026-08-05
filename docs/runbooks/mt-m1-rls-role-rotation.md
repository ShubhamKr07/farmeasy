# MT-M1 RLS Role Rotation

**Date:** 2026-08-05
**Environment:** staging (`farmsmart-api-staging`, Supabase project `farmsmart-staging` / ref `jkxlbndnatkxmhpumvhh`)

## What changed

Provisioned `farmsmart_app`, a least-privilege Postgres role with no
`BYPASSRLS` attribute (Supabase's default `postgres`/`service_role` both
have it, which silently made every RLS policy in
`00007_tenancy_rls_policies.sql` a no-op for the backend's own connection).
Rotated staging's `DATABASE_URL` (Render service `farmsmart-api-staging`,
`srv-d9m9928ae00c73bmc7k0`) to use it.

```sql
CREATE ROLE farmsmart_app WITH LOGIN PASSWORD '<generated, stored only in Render's env vars>';
GRANT USAGE ON SCHEMA public TO farmsmart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmsmart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO farmsmart_app;
GRANT authenticated TO farmsmart_app;
```

## Verification

- `verify-db-role.mjs` against `farmsmart_app` on staging: **`Connected as:
  farmsmart_app` / `BYPASSRLS: false`** — exits 0.
- Manual replay of the real `POST /facilities` transaction (org + facility +
  3 rooms + `users` update + `organization_members` insert, the exact
  statement sequence `facilities.ts` runs) as `farmsmart_app` against
  staging: succeeds cleanly with a genuinely fresh user.
- Full `api-server` test suite run against staging with `DATABASE_URL`/
  `TEST_DATABASE_URL` pointed at `farmsmart_app`: down to failures confined
  to one known, pre-existing, unrelated test-isolation bug (see below) —
  every RLS/grant gap this rotation could plausibly expose has been found
  and fixed.

## Real, pre-existing gaps found and fixed during this rotation

Rotating to a genuinely-enforced role surfaced several real gaps that had
been invisible under `postgres`/`service_role` (BYPASSRLS). None of these
are specific to staging — they would affect production the same way once
rotated there.

1. **Staging's schema was stale.** Only 17 of 26 Drizzle migrations were
   applied (missing `0018`-`0025`, the entire tenancy-scoping set —
   `organization_members` didn't exist at all) and only Supabase migrations
   `00001`-`00006` were recorded. Staging was bootstrapped 2026-07-31 and
   never migrated forward as MT-M0/MT-M1 landed on `main` — all
   MT-M0/MT-M1 testing had run against disposable/CI Postgres stacks, never
   against this persistent project. Fixed: ran the full Drizzle migration
   set + `supabase db push --include-all` against staging directly.
2. **`public.users` RLS (`00002_users_rls.sql`) had no path for a trusted
   backend role** — only `auth.uid() = id` policies, designed for the
   mobile client's direct Supabase connection, not this Express backend's
   own pooled connection (which never sets `auth.uid()`). Fixed:
   `00009_users_backend_role_policy.sql` (additive
   `current_user = 'farmsmart_app'` SELECT/UPDATE policies).
3. **`organizations`/`wizard_progress`/`sensor_accounts`/
   `facility_readiness_events`/`wizard_events`** (`00006_onboarding_tables_rls.sql`)
   had RLS enabled with **zero policies at all** — safe only because the
   backend always ran as `postgres`/`service_role`. Fixed:
   `00010_onboarding_tables_backend_role_policy.sql` (additive
   `current_user`-scoped policies, exactly the commands each real route
   uses — no more).
4. **`organization_members` had no INSERT policy** for the bootstrap case:
   `POST /facilities` inserts the owner-membership row in the same
   transaction that creates the organization itself, so
   `current_setting('app.org_id')` can't already match an org id that
   doesn't exist yet. Fixed: `00011_organization_members_backend_insert_policy.sql`.
5. **Test-harness gaps** (not production bugs, but blocked verification):
   `TRUNCATE ... RESTART IDENTITY` requires table/sequence ownership, which
   a least-privilege role correctly can't have; several test files insert
   fixture rows directly into tenant-scoped tables (bypassing
   `withTenantScope`, so `app.facility_id` is never set); `req.log` was
   undefined in the test harness, masking real errors behind a secondary
   crash. Fixed via a `TEST_ADMIN_DATABASE_URL`-backed `getAdminDb()`/
   `getAdminPool()` helper (`testDatabase.ts`) used only for these
   test-only needs, and a real (silent-level) pino logger in `testApp.ts`.
6. **`metrics.test.ts`/`parity.test.ts`'s golden fixture was stale** against
   the tenancy migrations (missing `facility_id`/`organization_id` on 7
   tables) and called the query templates with the pre-Task-11 function
   signature (no `facilityId`/`timezone`). Unrelated to RLS — would have
   broken in any environment with the current schema. Fixed directly.

## Known, deferred gap (not fixed as part of this rotation)

`facilities.test.ts` assumes the shared synthetic test user
(`DEFAULT_TEST_USER.sub`) starts with zero `organization_members` rows, an
assumption broken once any other file (or earlier test case) gives that
same user a real membership first via `seedTenantContext`. Not a race
(`--test-concurrency=1`) — a genuine cross-file/cross-case ordering
dependency. Logged as **Task 16** in this milestone's plan
(`docs/superpowers/plans/2026-08-04-multi-tenancy-mt-m1-isolation-core.md`),
deliberately deferred rather than fixed inline, since it is unrelated to
the RLS rotation itself.

All of the above (1-6) were latent and undetected because this branch has
never had a CI run (never pushed/PR'd) — the disposable-Supabase CI job
would have caught #6 and possibly #5 the first time it ran; #1-4 are
specific to this persistent staging project never having been migrated
forward, which no CI job checks for (see the "how was this missed"
discussion below).

## Why staging fell behind (and how to prevent it recurring)

No CI job asserts that a persistent environment (staging) has actually
received the migrations present in `lib/db/drizzle/*.sql`/
`supabase/migrations/*.sql` on `main`. The foundation pgTAP test
(`supabase/tests/00001_foundation.sql`) only proves migrations work against
a *fresh, disposable* replay (`scripts/ci/test-disposable-supabase.sh`), not
that any specific persistent project has them applied. Worth a follow-up:
a scheduled/CI check connecting to staging and asserting
`drizzle.__drizzle_migrations` / `supabase_migrations.schema_migrations`
row counts match the repo's current migration file counts.

## Production

**Not done in this task** — this runbook covers staging only, per this
plan's scope. Rotate production's `DATABASE_URL` the same way, after this
plan's Task 14 (isolation suite) has proven the rotated staging role
behaves correctly under real cross-tenant traffic patterns, and after
Task 16's test-isolation audit is complete (so a real CI run against the
rotated role stays green going forward).
