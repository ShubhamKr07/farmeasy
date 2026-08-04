# Runbook: Tenancy-safe database role

**Why:** Supabase's default `postgres` and `service_role` roles both have
`BYPASSRLS` — if `DATABASE_URL` connects as either, every RLS policy added
in the multi-tenancy initiative is a silent no-op. Verified via
`scripts/ci/verify-db-role.mjs`.

## Result of the MT-M0 check

**No live staging connection was reachable from the environment in which
Task 7 was executed, so the check could NOT be run. This section is an
explicit "not yet run" statement, not a recorded result.**

What was actually checked during Task 7:

- Environment variables inspected: `STAGING_DATABASE_URL_DIRECT` (empty)
  and `DATABASE_URL` (empty). Neither is set in this environment.
- No `.env` file is present in the repository worktree.
- The verification script itself was exercised only on its no-connection
  error path (`DATABASE_URL` unset → it prints `DATABASE_URL must be set`
  and exits `1`) and a syntax check (`node --check` passes). It was **not**
  pointed at any database, local or otherwise — a check run against a
  throwaway local Postgres would say nothing about the role configured for
  the staging/production API server and is explicitly out of scope here.

**Required follow-up before any RLS policy written in Task 8 is trusted:**
a human with real access to the staging Supabase project must run, from an
environment where the staging direct connection string is available:

```sh
DATABASE_URL="$STAGING_DATABASE_URL_DIRECT" node scripts/ci/verify-db-role.mjs
```

and record the real output here. Until that shows `BYPASSRLS: false`,
proceed under the assumption that the API server's DB role bypasses RLS
(i.e. assume policies are unenforced) — which is exactly the assumption
that makes provisioning the `farmsmart_app` role below mandatory.

If a result is obtained, replace this section with the recorded output in
the form:

```
Connected as: <role>
BYPASSRLS: <true|false>
```

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
