# Runbook: Tenancy-safe database role

**Why:** Supabase's default `postgres` and `service_role` roles both have
`BYPASSRLS` — if `DATABASE_URL` connects as either, every RLS policy added
in the multi-tenancy initiative is a silent no-op. Verified via
`scripts/ci/verify-db-role.mjs`.

## Result of the MT-M0 check (superseded — see MT-M1 below)

At the time Task 7 (MT-M0) ran, no live staging connection was reachable
from that environment, so the check could not be run there. That gap is
now resolved for staging.

## Staging: resolved (MT-M1 Task 13, 2026-08-05)

`farmsmart_app` is provisioned and live on staging (`farmsmart-api-staging`).
`verify-db-role.mjs` confirms `Connected as: farmsmart_app` /
`BYPASSRLS: false`. Full details, the real gaps found and fixed while
rotating (stale staging schema, missing RLS policies on `users`/
`organizations`/onboarding tables/`organization_members`), and the one
known deferred test-isolation issue: **`docs/runbooks/mt-m1-rls-role-rotation.md`**.

## Production: still open

Production's `DATABASE_URL` still connects as `postgres`/`service_role`
(BYPASSRLS). Rotate it the same way as staging, after this plan's Task 14
(isolation suite) has proven the rotated role behaves correctly under real
cross-tenant traffic, and after Task 16 (test-isolation audit) is done.

## If a new role is needed

Provision it in the Supabase SQL editor (or via a migration, if preferred —
this one is intentionally NOT run through Drizzle's migration runner, since
it's a role/grant operation, not a schema change scoped to this app's
tables):

```sql
CREATE ROLE farmsmart_app LOGIN PASSWORD '<generate a strong password>';
GRANT USAGE ON SCHEMA public TO farmsmart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmsmart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmsmart_app;
-- farmsmart_app has no BYPASSRLS by default (unlike postgres/service_role) --
-- do not add BYPASSRLS to it.
```

Then rotate `DATABASE_URL` in Render's env vars (staging first, verified
with `verify-db-role.mjs` showing `BYPASSRLS: false`, then production) to
a connection string authenticating as `farmsmart_app` against the same
Supabase project's transaction pooler.
