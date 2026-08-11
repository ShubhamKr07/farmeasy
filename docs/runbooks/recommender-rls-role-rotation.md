# Recommender RLS role rotation

**Purpose:** rotate `farmsmart-recommender`'s runtime `DATABASE_URL` from
Supabase's default `postgres`/`service_role` (BYPASSRLS) — or whatever
elevated role it runs as today — to a dedicated, least-privilege,
**non-BYPASSRLS** `farmsmart_recommender` role, so the RLS policies scoping
its reads (`00007`'s role-agnostic `app.org_id`/`app.facility_id` policies,
`00022`'s role-agnostic crops policy, and this task's
`recommender_cache`/`recommender_queries`/`bad_tray_entries` policies) are
actually enforced for the recommender's own connection.

**Relates to:** MT-M2 task #5 (recommender tenant-scoped read role). See
`docs/superpowers/specs/2026-08-11-mt-m2-recommender-tenant-scoped-role-design.md`
and `docs/superpowers/plans/2026-08-11-mt-m2-recommender-role.md`.

> **Scope:** this rotates **`farmsmart-recommender`'s `DATABASE_URL` (the
> asyncpg runtime connection: `cache_repo.py`, `embed_upsert.py`,
> `farm_context.py`, `query_log.py`) only.** `DATABASE_URL_DIRECT` (dlt's
> psycopg2-based Tavily-ingest pipeline, `ingest.py`) is **NOT** rotated
> here — it writes to the separate `recommender_staging` dlt-owned schema
> (not `public`), needs session-level SQL the transaction pooler rejects
> (hence the *session*-pooler connection already in place, see ADR-003), and
> the read-table audit for this task found no reason to touch it. Revisit
> only if a future audit finds `recommender_staging` needs the same
> least-privilege treatment.

> **⚠ Blast radius — read `docs/runbooks/prod-rls-role-rotation.md`'s
> blast-radius warning first.** This rotation only *creates a new role*
> (`farmsmart_recommender`); it never touches the `postgres`/`service_role`
> password. If that password is ever reset, `farmsmart-recommender`'s runtime
> `DATABASE_URL` (whatever role it's on at the time) is one of the casualties
> — rotate it in the same change as everything else on `postgres`.

---

## Step 0 — Read-table audit (already done; recorded here for the SQL below)

Grepped `artifacts/recommender-svc/app/{farm_context,cache_repo,embed_upsert,query_log,ingest}.py`
for every table referenced under the asyncpg (`DATABASE_URL`) connection:

| Table                 | Verbs         | Caller                                    |
|------------------------|---------------|--------------------------------------------|
| `crops`                | SELECT        | `farm_context.py` (crop/seed matching)     |
| `growth_profiles`      | SELECT        | `farm_context.py`                          |
| `cycles`                | SELECT (JOIN) | `farm_context.py` (bad-tray↔cycles join)   |
| `bad_tray_entries`     | SELECT        | `farm_context.py`                          |
| `recommender_cache`    | SELECT, INSERT| `cache_repo.py` (search), `embed_upsert.py` (upsert) |
| `recommender_queries`  | INSERT        | `query_log.py` (audit log; SELECT granted too, for the future "recent questions" UI) |

`ingest.py`'s dlt pipeline runs under `DATABASE_URL_DIRECT` (out of scope,
see above) against `recommender_staging.raw_docs`, not any table in this list.

## Step 1 — Create the role + grants in the PROD Supabase project

Run in the **production** project's **SQL Editor** (Dashboard → SQL Editor).
Generate a strong password yourself (e.g. `openssl rand -base64 32`) and
paste it in place of `<generated>`. **Claude never sees this password.**

```sql
CREATE ROLE farmsmart_recommender WITH LOGIN PASSWORD '<generated, store only in Render env>';
GRANT USAGE ON SCHEMA public TO farmsmart_recommender;
GRANT SELECT ON public.crops, public.growth_profiles, public.cycles, public.bad_tray_entries TO farmsmart_recommender;
GRANT SELECT, INSERT ON public.recommender_cache, public.recommender_queries TO farmsmart_recommender;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_recommender;  -- covers recommender_cache.id / recommender_queries.id serials
-- NO write grants on any tenant-scoped table (cycles, bad_tray_entries, growth_profiles, crops).
-- NOT BYPASSRLS -- do not add that attribute.
```

Verify immediately (same editor):

```sql
SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'farmsmart_recommender';
-- expect: farmsmart_recommender | f | t
```

## Step 2 — Swap the runtime `DATABASE_URL` (Render)

Render → **`farmsmart-recommender`** service → **Environment** → edit
`DATABASE_URL`:
- New value: the **transaction pooler** connection string authenticating as
  `farmsmart_recommender` (same pooler host/port as today; user + password
  change). Ensure it carries `sslmode=require`.
- **Before overwriting, copy the current value somewhere** — that is the
  rollback token.
- Leave `DATABASE_URL_DIRECT` **unchanged** (see the scope note above) unless
  the `postgres` password itself was reset, in which case re-sync it too, in
  the same change as everything else on `postgres` — see the blast-radius
  warning.

Saving the env var triggers a `farmsmart-recommender` redeploy.

## Step 3 — Verify enforcement

Two checks:

1. **Automated BYPASSRLS check (CI).** Add a GitHub **production**-environment
   secret `PRODUCTION_RECOMMENDER_DATABASE_URL` = the same
   `farmsmart_recommender` runtime string, then run the one-shot workflow:
   - Actions → **"Verify recommender DB role (BYPASSRLS check)"** → **Run
     workflow** (or `gh workflow run verify-recommender-db-role.yml`).
   - It runs `scripts/ci/verify-db-role.mjs` with `EXPECTED_DB_ROLE=farmsmart_recommender`,
     which **exits 1 if the connected role bypasses RLS OR isn't named
     `farmsmart_recommender`**. Green = `farmsmart_recommender` / `BYPASSRLS: false`.
2. **Functional smoke.** A real `POST /api/recommend` from an authenticated
   user with an `X-Facility-Id` (a real facility they belong to) must still
   return a grounded answer — proving no RLS/grant gap 500s (or silently
   empty-context 200s) under enforcement. Ask a question naming a real crop/
   seed on that tenant's own `growth_profiles` and confirm the answer's
   grounding text reflects it (not "no data").

## Rollback

Instant: Render → `farmsmart-recommender` → `DATABASE_URL` → paste back the
saved prior value → save (redeploys). RLS reverts to a no-op for this
connection (or, if the prior role was already non-BYPASSRLS, whatever
enforcement that role had) but the service is fully restored. Investigate the
failing query's missing policy/grant on staging (under
`farmsmart_recommender`) before re-attempting.

## Deferred (tracked, not part of this rotation)

- **`DATABASE_URL_DIRECT` (dlt ingest) role** — kept on its current elevated
  role; see the scope note above.
- **Staging** rotation follows the same steps against the staging Supabase
  project + `farmsmart-recommender-staging` — do this FIRST, before prod, and
  confirm isolation there (see the plan's Task 6 isolation proof) before
  touching prod.
