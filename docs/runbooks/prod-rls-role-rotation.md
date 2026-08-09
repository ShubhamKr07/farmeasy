# Production RLS role rotation

**Purpose:** rotate the production `farmsmart-api` runtime `DATABASE_URL` from
Supabase's default `postgres`/`service_role` (both `BYPASSRLS`) to a
least-privilege `farmsmart_app` role that does **not** bypass RLS — so the RLS
policies already applied to prod (migrations `00007`–`00018`) are actually
enforced for the backend's own connection.

**Prereqs (all true as of 2026-08-09):**
- Production has been deployed for the first time (`deploy-production` `success`
  at `af17d4a`): prod migrations applied, all 3 Render services live.
- Prod schema is at parity with `main` by construction (migrations just applied)
  — the scheduled drift check covers staging; prod parity is guaranteed by the
  deploy that just ran.
- Staging already runs on `farmsmart_app` and every RLS/grant gap this rotation
  could expose was found + fixed there (MT-M1 Task 13's 4 fixes + `00018`).

> **Scope:** this rotates **`farmsmart-api` only.** `farmsmart-dashboard` has no
> `DATABASE_URL` (SPA frontend). `farmsmart-recommender` is deliberately **NOT**
> rotated here — it runs cross-tenant reference/aggregate reads with no tenant
> context and would be broken by a plain non-BYPASSRLS role; it needs its own
> scoped `farmsmart_recommender` role (see the parked follow-up on the TEN-013
> task).

---

## Step 1 — Create the role + grants in the PROD Supabase project

Run in the **production** project's **SQL Editor** (Dashboard → SQL Editor). It
connects as `postgres` (has `CREATEROLE` + can `GRANT authenticated`). Generate
a strong password yourself (e.g. `openssl rand -base64 32`) and paste it in
place of `<generated>`. **Claude never sees this password.**

```sql
CREATE ROLE farmsmart_app WITH LOGIN PASSWORD '<generated, store only in Render's env>';
GRANT USAGE ON SCHEMA public TO farmsmart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmsmart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO farmsmart_app;
GRANT authenticated TO farmsmart_app;
```

Verify immediately (same editor):

```sql
SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'farmsmart_app';
-- expect: farmsmart_app | f | t
```

## Step 2 — Swap the prod runtime `DATABASE_URL` (Render)

Render → **`farmsmart-api`** service → **Environment** → edit `DATABASE_URL`:
- New value: the **transaction pooler** connection string authenticating as
  `farmsmart_app` (same pooler host/port as today; user + password change).
  Ensure it carries `sslmode=require` (Supabase pooler default).
- **Before overwriting, copy the current `postgres` value somewhere** — that is
  the rollback token.
- Leave the GitHub secret `PRODUCTION_DATABASE_URL_DIRECT` (migrations, needs an
  elevated role) **unchanged**.

Saving the env var triggers a `farmsmart-api` redeploy.

## Step 3 — Verify enforcement

Two checks:

1. **Automated BYPASSRLS check (CI).** Add a GitHub **production**-environment
   secret `PRODUCTION_DATABASE_URL` = the same `farmsmart_app` runtime string,
   then run the one-shot workflow:
   - Actions → **"Verify prod DB role (BYPASSRLS check)"** → **Run workflow**
     (or `gh workflow run verify-prod-db-role.yml`).
   - It runs `scripts/ci/verify-db-role.mjs`, which **exits 1 if the connected
     role bypasses RLS**. Green = `farmsmart_app` / `BYPASSRLS: false`.
2. **Functional smoke.** A real prod signup + one facility-scoped write
   (e.g. the private-media probe path, or a manual `POST /api/facility-logs`
   with a valid `X-Facility-Id`) must succeed — proving no RLS/grant gap 500s
   under enforcement.

## Rollback

Instant: Render → `farmsmart-api` → `DATABASE_URL` → paste back the saved
`postgres` value → save (redeploys). RLS reverts to a no-op (BYPASSRLS) but the
service is fully restored. Investigate the failing query's missing policy/grant
on staging (under `farmsmart_app`) before re-attempting.

## Deferred (tracked, not part of this rotation)

- **`farmsmart-recommender` role rotation** — needs a dedicated read-scoped
  `farmsmart_recommender` role; see the parked follow-up on the TEN-013 task.
  Until then the recommender remains on its current elevated role.
- **`recommender-svc` staging** rotation follows the same plan.
