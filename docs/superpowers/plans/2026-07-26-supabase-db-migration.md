# Supabase DB Migration (Neon → Supabase Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Neon Postgres with Supabase Postgres as the sole database for `farmsmart-api` and `farmsmart-recommender`, with zero data loss and zero app-code assumptions about Neon left in the codebase. Render stays the compute host for all three services — this plan touches the database layer only.

**Architecture:** One Supabase project (prod only, per the confirmed single-environment decision — this mirrors the current Render setup, which has no staging service either). Drizzle ORM/migrations are already vanilla Postgres (no Neon-specific driver), so the cutover is: install tooling → fix two Neon-specific assumptions found in the code → apply the existing migration history to a fresh Supabase database → move data → repoint Render's env vars → verify → keep the old Neon project as a dormant rollback for a retention window before decommissioning.

**Tech Stack:** Supabase CLI (`supabase` npm package), Supabase Postgres 17 + Supavisor (connection pooler), Drizzle ORM/Kit (existing), `pg` (Node driver, existing), `asyncpg` (Python driver, existing), `pg_dump`/`pg_restore`.

## Global Constraints

- pnpm is the only package manager in this repo (root `package.json` `preinstall` guard) — every install command in this plan uses `pnpm`, never `npm`/`yarn`.
- pnpm 11.x blocks package `postinstall` scripts by default unless the package is listed under `onlyBuiltDependencies` in `pnpm-workspace.yaml` — this is a known, currently-open issue for the `supabase` npm package specifically (supabase/cli#3489, #860, #1809) and Task 1 below exists to pre-empt it.
- `NEON_DATABASE_URL` is being retired as an env var name everywhere it appears (code, `render.yaml`, `.env`, `README.md`, `DEPLOY.md`) — `DATABASE_URL` is the only DB connection env var after this plan.
- Migrations remain Drizzle-managed (`lib/db/drizzle/*.sql`, `lib/db/scripts/migrate.mjs`) — this plan does not introduce Supabase's own migration tooling (`supabase migration ...`) as a second, competing migration system.
- The existing Neon project is **not deleted** as part of this plan — it stays live and untouched as the rollback path until the retention window in Task 10 closes, per the same discipline the (now-superseded) ADR-002 already established for the GCP migration.
- No changes to Auth (Clerk) or file uploads (`media.ts`, local disk) in this plan — those are separate, already-sequenced plans (Auth, then Storage).

---

## File Structure

```
supabase/                                          # new — created by `supabase init` (Task 2)
  config.toml                                      # committed; no secrets in it

docs/adr/
  ADR-002.md                                       # modified — status line marked Superseded
  ADR-003.md                                       # new — Postgres provider: Neon -> Supabase

lib/db/
  src/index.ts                                     # modified — drop NEON_DATABASE_URL fallback
  scripts/migrate.mjs                               # modified — drop NEON_DATABASE_URL fallback

artifacts/recommender-svc/
  app/config.py                                     # modified — new database_url_direct field
  app/ingest.py                                      # modified — drop Neon hostname-hack
  app/db.py                                          # modified — comment accuracy only
  pyproject.toml                                     # modified — add pytest as dev dependency
  tests/__init__.py                                  # new
  tests/test_ingest.py                               # new — TDD for the hostname-hack fix

render.yaml                                          # modified — Supabase env vars, comments
.env                                                  # modified — comment accuracy only
README.md                                             # modified — Neon -> Supabase references
DEPLOY.md                                             # modified — Neon -> Supabase references
```

---

### Task 1: Install Supabase CLI as a workspace dev dependency

**Files:**
- Modify: `package.json` (repo root)
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: `pnpm exec supabase <command>` runnable from repo root for every later task.

- [ ] **Step 1: Install the CLI**

Run:
```bash
pnpm add -D supabase -w
```
Expected: install completes; likely prints a warning:
```
WARN  Failed to create bin at /node_modules/.bin/supabase
```
This is the known pnpm-postinstall-blocking issue (supabase/cli#3489) — expected at this point, fixed in Step 2.

- [ ] **Step 2: Allow the postinstall build script**

Open `pnpm-workspace.yaml`, find the existing `onlyBuiltDependencies:` list (currently `@swc/core`, `esbuild`, `msw`, `unrs-resolver`), add `supabase`:

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
  - msw
  - unrs-resolver
  - supabase
```

- [ ] **Step 3: Re-run install so the postinstall (binary download) actually executes**

Run:
```bash
pnpm install
```
Expected: no "Failed to create bin" warning this time; `node_modules/.bin/supabase` exists.

- [ ] **Step 4: Verify the CLI runs**

Run:
```bash
pnpm exec supabase --version
```
Expected: prints a version number (e.g. `2.x.x`), not a "command not found" error.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(db): add Supabase CLI as workspace dev dependency"
```

---

### Task 2: Scaffold and link the Supabase project

**Files:**
- Create: `supabase/config.toml` (via CLI, then commit)
- Modify: `.gitignore` (ensure `supabase/.temp` and any local secrets dir are ignored — check first, Supabase's default `.gitignore` inside `supabase/` usually covers this)

**Interfaces:**
- Produces: a linked Supabase project (`SUPABASE_PROJECT_REF`) whose three connection strings (direct, session pooler, transaction pooler) are used by every later task.

- [ ] **Step 1: Initialize the local Supabase config**

Run:
```bash
pnpm exec supabase init
```
Expected: creates `supabase/config.toml` and `supabase/.gitignore` at repo root.

- [ ] **Step 2: `[HUMAN]` Authenticate the CLI**

Run:
```bash
pnpm exec supabase login
```
Expected: opens a browser, completes OAuth, CLI prints "You are now logged in."

- [ ] **Step 3: `[HUMAN]` Create the Supabase project**

Single prod-only project, per the confirmed environment decision. Create via the [Supabase dashboard](https://supabase.com/dashboard) (simpler than scripting a one-time click) — name it `farmsmart`, choose a region close to wherever Render's `oregon` region actually routes from (Render's `oregon` region is AWS `us-west-2`-adjacent; pick the nearest Supabase region, e.g. `us-west-1` or `us-west-2` — confirm current options in the dashboard's region dropdown, since Supabase's region list changes over time, same caveat ADR-002 raised for Neon), and set a strong database password.

Record: project ref (visible in the dashboard URL and in Project Settings → General), and the database password (you will not be shown it again).

- [ ] **Step 4: `[HUMAN]` Collect the three connection strings**

From Project Settings → Database → Connection String, copy all three variants:
- **Direct** (`db.<ref>.supabase.co:5432`) — IPv6 only unless the IPv4 add-on is purchased. Used only for the one-time `pg_dump`/`pg_restore` in Task 8, from wherever you're running that (your machine or CI — confirm it has IPv6 egress, or use the Session Pooler string instead if it doesn't).
- **Session pooler** (`aws-0-<region>.pooler.supabase.com:5432`) — IPv4-compatible, supports session-level SQL (`SET`, prepared statements). Used for Drizzle migrations (Task 7) and as the safe default for `pg_restore` if direct/IPv6 isn't available.
- **Transaction pooler** (`aws-0-<region>.pooler.supabase.com:6543`) — IPv4-compatible, no session state, highest connection churn tolerance. Used as the **runtime** `DATABASE_URL` for both `farmsmart-api` and `farmsmart-recommender` (Task 9) — this is the direct analog of the pooled endpoint Neon was providing today.

Keep these three values somewhere secret-managed (password manager, or directly into Render's env var UI in Task 9) — do not commit them.

- [ ] **Step 5: Link the CLI to the project**

Run (replace `<ref>` with the project ref from Step 3):
```bash
pnpm exec supabase link --project-ref <ref>
```
Expected: prompts for the database password from Step 3, then prints "Finished supabase link."

- [ ] **Step 6: Commit the non-secret scaffold**

```bash
git add supabase/config.toml supabase/.gitignore
git commit -m "chore(db): scaffold and link Supabase project"
```

---

### Task 3: Write ADR-003 and supersede ADR-002

**Files:**
- Create: `docs/adr/ADR-003.md`
- Modify: `docs/adr/ADR-002.md:3` (status line)

**Interfaces:**
- Consumes: the three-connection-string model from Task 2 Step 4.
- Produces: the pooled/direct policy every later task (7, 9) points back to, replacing ADR-002's Neon-specific version of the same table.

- [ ] **Step 1: Mark ADR-002 superseded**

In `docs/adr/ADR-002.md`, change line 3 from:
```
**Status:** Proposed (authored Lane 1, not yet Accepted — acceptance requires the INF-202 relocation to actually complete and pass its Verify in Lane 2)
```
to:
```
**Status:** Superseded by ADR-003 — the GCP migration this ADR was written for was abandoned before Neon relocation ran; Neon itself is being replaced by Supabase, not relocated. Left in place for historical context on the pooled-vs-direct reasoning, which ADR-003 carries forward.
```

- [ ] **Step 2: Write ADR-003**

Create `docs/adr/ADR-003.md`:

```markdown
# ADR-003: Replace Neon with Supabase Postgres

**Status:** Proposed (authored ahead of Task 7's cutover — acceptance requires
the data migration in Task 8 to complete and pass its Verify)
**Date:** 2026-07-26
**Related:** ADR-002 (superseded — Neon retention/relocation reasoning this
ADR replaces), `docs/superpowers/plans/2026-07-26-supabase-db-migration.md`

## Context

ADR-002 planned to retain Neon and relocate it alongside a GCP compute
migration. That GCP migration was abandoned before execution (infra branch
deleted, nothing was ever applied against real cloud resources). Independently
of that, the decision has been made to move off Neon entirely and adopt
Supabase — not just for Postgres, but as the platform for Auth and Storage in
follow-on plans. This ADR covers the database piece only.

Render remains the compute host for `farmsmart-api`, `farmsmart-recommender`,
and `farmsmart-dashboard` — this is a database-provider swap, not a compute
migration.

## Decision

**Replace Neon with Supabase Postgres.** Single project, no staging/prod
split (matches the current Render setup, which is single-environment today).

Reasoning:
- The app's data-access layer (Drizzle ORM, `pg` driver on the Node side,
  `asyncpg` on the Python side) has no Neon-specific extensions in use beyond
  connection pooling, and Supabase's pgvector support (already required by
  `recommender_cache`, migration `0008_p6_recommender.sql`) is first-class,
  not a bolt-on — no schema changes are needed for the embedding column or
  its HNSW index.
- Two genuinely Neon-specific assumptions exist in the codebase and must be
  fixed regardless of destination (Task 4, Task 5) — this migration is the
  forcing function to remove them rather than carry them forward disguised
  as generic code.

## Connection string policy (supersedes ADR-002's table)

Supabase provides three connection endpoints per project (not two, like
Neon) — see [Supabase's connection docs](https://supabase.com/docs/guides/database/connecting-to-postgres):

| Use | Endpoint | Why |
|---|---|---|
| `farmsmart-api` runtime (`DATABASE_URL`) | **Transaction pooler** (port 6543) | Same reasoning as ADR-002's Neon-pooled choice: Render's per-request connection churn needs Supavisor's multiplexing, not a direct connection per request. |
| `farmsmart-recommender` runtime (`DATABASE_URL`) | **Transaction pooler** (port 6543) | Same reasoning, lower expected concurrency. `asyncpg`'s own pool (`app/db.py`) sits on top of this. |
| `lib/db/scripts/migrate.mjs` (schema migrations) | **Session pooler** (port 5432, `pooler.supabase.com` host) | DDL needs session-level guarantees the transaction pooler doesn't provide. Direct connection (`db.<ref>.supabase.co`) would also work but is IPv6-only unless the IPv4 add-on is purchased — session pooler gets the same session guarantees over IPv4, so it's the safer default when the runner's IPv6 support is unconfirmed. |
| `dlt`'s `psycopg2` destination (`app/ingest.py`, `_unpooled_database_url`) | **Session pooler** | `psycopg2`/`dlt` sets `search_path` via a connection startup parameter, which the transaction pooler rejects ("unsupported startup parameter"). This was previously solved by string-replacing `-pooler.` out of the Neon hostname (Task 4 fixes this — Supabase's pooled and direct hostnames aren't related by substring, so the old hack cannot work here). |
| `pg_dump`/`pg_restore` (Task 8) | **Session pooler** (or direct, if IPv6 confirmed) | One-shot bulk operation; session pooler avoids depending on the operator's ISP supporting IPv6. |

## Consequences

- Two env vars are now required by `farmsmart-recommender` where one existed
  before: `DATABASE_URL` (transaction pooler, app runtime) and
  `DATABASE_URL_DIRECT` (session pooler, `dlt` ingestion only). Both are
  Supabase connection strings to the same project — not two databases.
- `NEON_DATABASE_URL` is retired everywhere (code, `render.yaml`, `.env`,
  docs) — `DATABASE_URL` is the only generically-named runtime var.
- Old Neon project stays untouched as the rollback path until the retention
  window in Task 10 closes.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-002.md docs/adr/ADR-003.md
git commit -m "docs(adr): ADR-003 — replace Neon with Supabase Postgres, supersede ADR-002"
```

---

### Task 4: Fix recommender-svc's Neon-specific hostname hack

`app/ingest.py` currently derives dlt's unpooled connection string by string-replacing `-pooler.` out of the pooled Neon hostname (`ep-xxx-pooler.region.aws.neon.tech` → `ep-xxx.region.aws.neon.tech`). Supabase's pooled hostname (`aws-0-<region>.pooler.supabase.com`) and its session/direct hostnames are **not related by substring** — this hack would silently produce a broken URL against Supabase, not fail loudly. Fix it to take an explicit, separate env var instead, per ADR-003.

**Files:**
- Modify: `artifacts/recommender-svc/app/config.py`
- Modify: `artifacts/recommender-svc/app/ingest.py`
- Modify: `artifacts/recommender-svc/app/db.py` (comment only)
- Modify: `artifacts/recommender-svc/pyproject.toml` (add `pytest` dev dependency)
- Create: `artifacts/recommender-svc/tests/__init__.py`
- Create: `artifacts/recommender-svc/tests/test_ingest.py`

**Interfaces:**
- Consumes: `settings.database_url_direct` (new field) as the Session Pooler connection string from ADR-003.
- Produces: `_unpooled_database_url() -> str`, same name/signature as before, so `app/ingest.py`'s other callers (the dlt pipeline construction below it) don't change.

- [ ] **Step 1: Add pytest as a dev dependency**

Run (from `artifacts/recommender-svc/`):
```bash
cd artifacts/recommender-svc && uv add --dev pytest
```
Expected: `pyproject.toml` gains a `[dependency-groups]` (or `[tool.uv]` dev-dependencies) entry for `pytest`; `uv.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `artifacts/recommender-svc/tests/__init__.py` (empty file).

Create `artifacts/recommender-svc/tests/test_ingest.py`:

```python
import pytest


def test_unpooled_database_url_uses_explicit_direct_var(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    monkeypatch.setenv("DATABASE_URL_DIRECT", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")

    settings = Settings()

    from app.ingest import _unpooled_database_url

    assert _unpooled_database_url(settings) == settings.database_url_direct


def test_unpooled_database_url_raises_when_direct_var_missing(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    monkeypatch.delenv("DATABASE_URL_DIRECT", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")

    settings = Settings()

    from app.ingest import _unpooled_database_url

    with pytest.raises(ValueError, match="DATABASE_URL_DIRECT"):
        _unpooled_database_url(settings)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
cd artifacts/recommender-svc && uv run pytest tests/test_ingest.py -v
```
Expected: both tests FAIL — `_unpooled_database_url` currently takes no arguments and does a string-replace, not an explicit-field lookup; `Settings` has no `database_url_direct` field yet (pydantic will raise or the attribute won't exist).

- [ ] **Step 4: Implement — add the field to Settings**

In `artifacts/recommender-svc/app/config.py`, add the new field after `database_url`:

```python
    database_url: str
    database_url_direct: str | None = None
```

Update the class docstring to mention it:
```python
    """
    Env vars (Render): DATABASE_URL (Supabase transaction-pooler connection
    string, app runtime), DATABASE_URL_DIRECT (Supabase session-pooler
    connection string — required only for dlt's psycopg2-based ingestion,
    which needs session-level SQL the transaction pooler rejects; see
    ADR-003), GEMINI_API_KEY (embeddings + synthesis — one provider, one
    key), TAVILY_API_KEY (live search on cache miss — optional),
    INTERNAL_API_KEY (shared secret validating requests came from
    api-server, not the public internet).
    """
```

- [ ] **Step 5: Implement — rewrite `_unpooled_database_url`**

In `artifacts/recommender-svc/app/ingest.py`, replace:
```python
def _unpooled_database_url() -> str:
    """
    dlt's postgres destination (psycopg2) sets search_path via a connection
    startup parameter, which Neon's pooled endpoint (PgBouncer, host
    contains "-pooler") rejects outright ("unsupported startup parameter in
    options: search_path"). asyncpg (cache_repo.py, embed_upsert.py) doesn't
    hit this, so only dlt's connection needs the direct/unpooled host.
    """
    return settings.database_url.replace("-pooler.", ".")
```
with:
```python
def _unpooled_database_url(settings=settings) -> str:
    """
    dlt's postgres destination (psycopg2) sets search_path via a connection
    startup parameter, which Supabase's transaction pooler rejects outright
    ("unsupported startup parameter in options: search_path"), same failure
    mode Neon's pooled endpoint had. asyncpg (cache_repo.py, embed_upsert.py)
    doesn't hit this, so only dlt's connection needs the session-pooler URL.

    Unlike Neon, Supabase's pooled and direct/session hostnames are not
    related by substring — this must be an explicit separate connection
    string (ADR-003), not derived from the pooled one.
    """
    if not settings.database_url_direct:
        raise ValueError(
            "DATABASE_URL_DIRECT must be set (Supabase session-pooler "
            "connection string) — dlt's ingestion pipeline cannot use the "
            "transaction-pooler DATABASE_URL."
        )
    return settings.database_url_direct
```

Check the one call site of `_unpooled_database_url()` later in `ingest.py` (the dlt pipeline construction) — it currently calls it with no arguments, which still works since `settings=settings` is a default argument; no call-site change needed.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd artifacts/recommender-svc && uv run pytest tests/test_ingest.py -v
```
Expected: both tests PASS.

- [ ] **Step 7: Update `app/db.py`'s comment for accuracy**

In `artifacts/recommender-svc/app/db.py`, replace the comment:
```python
            # Neon requires SSL; asyncpg respects sslmode in the DSN itself,
            # but Neon's pooled connection strings sometimes omit it — force it.
            ssl="require",
```
with:
```python
            # Supabase requires SSL on all connection endpoints; force it
            # explicitly rather than relying on the DSN including it.
            ssl="require",
```

- [ ] **Step 8: Commit**

```bash
git add artifacts/recommender-svc/app/config.py artifacts/recommender-svc/app/ingest.py artifacts/recommender-svc/app/db.py artifacts/recommender-svc/pyproject.toml artifacts/recommender-svc/uv.lock artifacts/recommender-svc/tests
git commit -m "fix(recommender): replace Neon hostname-hack with explicit DATABASE_URL_DIRECT"
```

---

### Task 5: Drop the `NEON_DATABASE_URL` fallback from `lib/db`

**Files:**
- Modify: `lib/db/src/index.ts`
- Modify: `lib/db/scripts/migrate.mjs`

**Interfaces:**
- Produces: both files read `process.env.DATABASE_URL` only — no behavior change for anyone already setting `DATABASE_URL` (which every current deploy target already does, per `render.yaml`'s "same value" comments).

- [ ] **Step 1: Update `lib/db/src/index.ts`**

Replace:
```typescript
const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
```
with:
```typescript
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
```

- [ ] **Step 2: Update `lib/db/scripts/migrate.mjs`**

Replace:
```javascript
const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("NEON_DATABASE_URL or DATABASE_URL must be set to run migrations");
}
```
with:
```javascript
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set to run migrations");
}
```

Also update the file's header comment:
```javascript
// Applies pending Drizzle migrations from ./drizzle to the configured database.
// Run: DATABASE_URL=... node scripts/migrate.mjs   (or `pnpm --filter @workspace/db run db:migrate`)
```
(no change needed here — it already says `DATABASE_URL=...` generically; leave as-is).

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm run typecheck
```
Expected: passes with no errors (this was a same-type variable, no signature change).

- [ ] **Step 4: Commit**

```bash
git add lib/db/src/index.ts lib/db/scripts/migrate.mjs
git commit -m "refactor(db): drop NEON_DATABASE_URL fallback, DATABASE_URL only"
```

---

### Task 6: Update `render.yaml` and docs to reference Supabase, not Neon

**Files:**
- Modify: `render.yaml`
- Modify: `DEPLOY.md`
- Modify: `README.md`
- Modify: `.env`

**Interfaces:**
- Produces: no `NEON_DATABASE_URL` key anywhere in `render.yaml`; a new `DATABASE_URL_DIRECT` key on the `farmsmart-recommender` service (per ADR-003 / Task 4).

- [ ] **Step 1: Update `render.yaml`'s header comment**

Replace:
```yaml
# Postgres is external (Neon) — set NEON_DATABASE_URL. Auth is Clerk.
```
with:
```yaml
# Postgres is external (Supabase) — set DATABASE_URL (transaction pooler).
# Auth is Clerk.
```

- [ ] **Step 2: Remove `NEON_DATABASE_URL` from the `farmsmart-api` service**

Replace:
```yaml
      - key: NEON_DATABASE_URL
        sync: false # Neon connection string (postgresql://...?sslmode=require)
      - key: DATABASE_URL
        sync: false # same Neon URL (fallback)
```
with:
```yaml
      - key: DATABASE_URL
        sync: false # Supabase transaction-pooler connection string (port 6543) — see ADR-003
```

- [ ] **Step 3: Update the `farmsmart-recommender` service block**

Replace:
```yaml
  # ── Recommender (Python/FastAPI, dlt ingestion + pgvector search) ─────────
  # Talks to the same Neon Postgres as farmsmart-api (DATABASE_URL). Only
  # farmsmart-api calls this service directly (INTERNAL_API_KEY-gated) — it
  # is not exposed to the dashboard or the public internet.
```
```yaml
    envVars:
      - key: DATABASE_URL
        sync: false # same Neon connection string as farmsmart-api
```
with:
```yaml
  # ── Recommender (Python/FastAPI, dlt ingestion + pgvector search) ─────────
  # Talks to the same Supabase Postgres as farmsmart-api (DATABASE_URL). Only
  # farmsmart-api calls this service directly (INTERNAL_API_KEY-gated) — it
  # is not exposed to the dashboard or the public internet.
```
```yaml
    envVars:
      - key: DATABASE_URL
        sync: false # same Supabase transaction-pooler string as farmsmart-api (port 6543)
      - key: DATABASE_URL_DIRECT
        sync: false # Supabase session-pooler string (port 5432) — dlt/psycopg2 ingestion only, see ADR-003
```

- [ ] **Step 4: Update `DEPLOY.md`**

Line 8, replace:
```
- **Postgres**: external Neon (keep `NEON_DATABASE_URL`).
```
with:
```
- **Postgres**: external Supabase (`DATABASE_URL` — transaction pooler; `DATABASE_URL_DIRECT` on the recommender service only, session pooler — see ADR-003).
```

Line 15, replace:
```
   - **farmsmart-api**: `NEON_DATABASE_URL` = Neon connection string; `CLERK_SECRET_KEY` = `sk_…`; `CLERK_PUBLISHABLE_KEY` = `pk_…`; `CORS_ORIGIN` = the dashboard URL (set after step 4).
```
with:
```
   - **farmsmart-api**: `DATABASE_URL` = Supabase transaction-pooler connection string; `CLERK_SECRET_KEY` = `sk_…`; `CLERK_PUBLISHABLE_KEY` = `pk_…`; `CORS_ORIGIN` = the dashboard URL (set after step 4).
```

Line 17, replace:
```
3. **Deploy the API first.** Wait for it to go live; note its URL. Run migrations against Neon once (locally is fine — they may already be applied): `DATABASE_URL=<neon> node lib/db/scripts/migrate.mjs`.
```
with:
```
3. **Deploy the API first.** Wait for it to go live; note its URL. Run migrations against Supabase once, using the session-pooler string (locally is fine — they may already be applied): `DATABASE_URL=<supabase-session-pooler-url> node lib/db/scripts/migrate.mjs`.
```

Line 25, replace:
```
DATABASE_URL=<neon-url> node lib/db/scripts/migrate.mjs
```
with:
```
DATABASE_URL=<supabase-session-pooler-url> node lib/db/scripts/migrate.mjs
```

Line 27, replace:
```
Neon already has migrations 0000–0005 applied.
```
with:
```
Supabase should already have all 10 migrations (0000–0009) applied from Task 7 of the DB migration plan.
```

Line 35, replace:
```
| `NEON_DATABASE_URL` | API | `postgresql://…?sslmode=require` |
```
with:
```
| `DATABASE_URL` | API | Supabase transaction-pooler string, `postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:6543/postgres` |
```

Line 50, replace:
```
| `DATABASE_URL` | Recommender | same Neon connection string as the API |
```
with:
```
| `DATABASE_URL` | Recommender | same Supabase transaction-pooler string as the API |
| `DATABASE_URL_DIRECT` | Recommender | Supabase session-pooler string (port 5432) — dlt ingestion only |
```

- [ ] **Step 5: Update `README.md`**

Line 9, replace:
```
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-4169E1?logo=postgresql&logoColor=white)](https://neon.tech/)
```
with:
```
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
```

Line 75, replace:
```
| Database     | PostgreSQL (Neon)                                       |
```
with:
```
| Database     | PostgreSQL (Supabase)                                   |
```

Line 88, replace:
```
- **PostgreSQL** — a Neon instance (or any Postgres) for `DATABASE_URL`
```
with:
```
- **PostgreSQL** — a Supabase instance (or any Postgres) for `DATABASE_URL`
```

- [ ] **Step 6: Update `.env`'s comment**

Replace:
```
# Local dev env — NOT committed (see .gitignore). Used for running drizzle migrations
# and the api-server against the managed Neon Postgres.
```
with:
```
# Local dev env — NOT committed (see .gitignore). Used for running drizzle migrations
# and the api-server against the managed Supabase Postgres.
```

- [ ] **Step 7: Commit**

```bash
git add render.yaml DEPLOY.md README.md .env
git commit -m "docs(infra): update Neon references to Supabase across render.yaml and docs"
```

---

### Task 7: Apply the existing migration history to Supabase

**Files:** none modified — this task runs existing tooling against the new database.

**Interfaces:**
- Consumes: `DATABASE_URL` = Supabase **session pooler** string (Task 2 Step 4), set as a local/CI env var for this task only — not committed anywhere.

- [ ] **Step 1: Run all 10 migrations against the fresh Supabase database**

Run (replace with the actual session-pooler string from Task 2):
```bash
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  pnpm --filter @workspace/db run db:migrate
```
Expected output ends with:
```
✓ migrations applied
```

- [ ] **Step 2: Verify schema and extension**

Using `psql` against the same session-pooler string (or the Supabase dashboard's SQL editor):
```sql
select extname from pg_extension where extname = 'vector';
```
Expected: one row, `vector`.

```sql
select count(*) from __drizzle_migrations;
```
Expected: `10` (migrations `0000_baseline` through `0009_absurd_devos`).

```sql
\d recommender_cache
```
Expected: table exists with an `embedding` column of type `vector(1536)` and an index named `recommender_cache_embedding_hnsw`.

- [ ] **Step 3: No commit** — this task only runs existing code against new infrastructure; nothing in the repo changes.

---

### Task 8: Migrate data from Neon to Supabase

**Files:** none modified.

**Interfaces:**
- Consumes: Neon's existing direct connection string (production, current `NEON_DATABASE_URL` value from Render's dashboard) and Supabase's session-pooler string (Task 2).
- Produces: `farmsmart-neon-data.dump` (local file, not committed — add to `.gitignore` if it isn't already covered by an existing `*.dump` ignore rule; check first).

- [ ] **Step 1: Dump data only from Neon (schema already applied via Task 7, don't re-create it)**

Run:
```bash
pg_dump "postgresql://<neon-direct-connection-string>" \
  --data-only --no-owner --no-privileges \
  --format=custom \
  --file=farmsmart-neon-data.dump
```
Expected: exits 0, prints table-by-table progress if `-v` is added; file exists and is non-trivial in size.

- [ ] **Step 2: Restore into Supabase**

Run:
```bash
pg_restore \
  --data-only --no-owner --no-privileges \
  --disable-triggers \
  -d "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  farmsmart-neon-data.dump
```
`--disable-triggers` avoids FK-check ordering issues during a data-only restore into a schema that already has the constraints from Task 7. Expected: exits 0; any warnings about sequence ownership are non-fatal (`pg_restore` restores data, sequences may need a manual bump — see Step 4).

- [ ] **Step 3: Verify row counts match between Neon and Supabase**

Run this query against **both** databases and diff the output:
```sql
select 'cycles' t, count(*) from cycles
union all select 'growth_profiles', count(*) from growth_profiles
union all select 'inventory_items', count(*) from inventory_items
union all select 'seed_lots', count(*) from seed_lots
union all select 'shipments', count(*) from shipments
union all select 'rooms', count(*) from rooms
union all select 'channels', count(*) from channels
union all select 'racks', count(*) from racks
union all select 'trays', count(*) from trays
union all select 'manual_checks', count(*) from manual_checks
union all select 'alerts', count(*) from alerts
union all select 'recommender_cache', count(*) from recommender_cache
order by 1;
```
Expected: identical counts on every row between the two databases.

- [ ] **Step 4: Fix sequence values (data-only restores don't advance `serial`/identity sequences)**

Run against Supabase, for every table with a `serial`/`bigserial` primary key (check `lib/db/src/schema/index.ts` for the current list — at minimum `recommender_cache.id` uses `serial`):
```sql
select setval(
  pg_get_serial_sequence('recommender_cache', 'id'),
  coalesce((select max(id) from recommender_cache), 1)
);
```
Repeat for every other `serial`-keyed table found in the schema. Expected: each returns the new sequence value with no error.

- [ ] **Step 5: Verify the `recommender_cache` embeddings restored correctly (pgvector-specific check)**

```sql
select id, vector_dims(embedding) from recommender_cache limit 5;
```
Expected: `vector_dims` returns `1536` for every row, matching the schema's declared dimension — confirms the vector column didn't get truncated or corrupted by the dump/restore round-trip.

- [ ] **Step 6: No commit** — this is a one-time data operation, not a code change. Keep `farmsmart-neon-data.dump` until Task 10's retention window closes, then delete it.

---

### Task 9: Cut Render over to Supabase

**Files:** none in the repo — this task is Render dashboard configuration + a redeploy.

**Interfaces:**
- Consumes: Task 2's transaction-pooler string (both services) and Task 4's `DATABASE_URL_DIRECT` (recommender only).

- [ ] **Step 1: `[HUMAN]` Update `farmsmart-api`'s env vars in the Render dashboard**

Remove `NEON_DATABASE_URL`. Set `DATABASE_URL` to the Supabase **transaction pooler** string from Task 2 Step 4.

- [ ] **Step 2: `[HUMAN]` Update `farmsmart-recommender`'s env vars in the Render dashboard**

Set `DATABASE_URL` to the same Supabase transaction-pooler string. Add `DATABASE_URL_DIRECT`, set to the Supabase **session pooler** string.

- [ ] **Step 3: Redeploy both services**

Trigger a manual deploy (or push a no-op commit if `autoDeploy` should pick it up) for `farmsmart-api` and `farmsmart-recommender`.

- [ ] **Step 4: Verify `farmsmart-api`**

```bash
curl -s https://<farmsmart-api-render-url>/api/healthz
```
Expected: `200` with the existing healthz body — confirms the API can reach Supabase over the transaction pooler.

- [ ] **Step 5: Verify `farmsmart-recommender`**

```bash
curl -s https://<farmsmart-recommender-render-url>/healthz
```
Expected: `200`.

Then exercise a real recommender query through `farmsmart-api` (the internal-key-gated path) and confirm it returns an answer, not a 500 — this specifically exercises the `DATABASE_URL_DIRECT`/dlt ingestion path fixed in Task 4, which the healthz check alone doesn't touch.

- [ ] **Step 6: Run the existing test suite against the live cutover**

```bash
cd artifacts/api-server && pnpm run test && pnpm run test:metrics
```
Expected: all pass — these tests run against whatever `DATABASE_URL` is configured in the test environment; confirm that's also pointed at Supabase (or a Supabase-backed test schema) before trusting this as a cutover signal, not just a pre-existing green baseline.

- [ ] **Step 7: No commit** — dashboard-only change; Task 6 already committed the `render.yaml` documentation of these vars.

---

### Task 10: Post-cutover monitoring and Neon decommission

**Files:**
- Modify: `docs/adr/ADR-003.md:3` (status line, once verified)

**Interfaces:** none — this is an operational/retention task.

- [ ] **Step 1: Mark ADR-003 Accepted**

Once Task 9's verification steps are all green, change ADR-003's status line from `Proposed` to (using the actual date this step is performed, not the date this plan was written):
```
**Status:** Accepted — cutover verified <YYYY-MM-DD>, Neon retained as rollback until the retention window below closes.
```

- [ ] **Step 2: `[HUMAN]` Keep the Neon project untouched for 7 days**

Do not delete or downgrade the Neon project. Monitor Render's logs and Supabase's dashboard (Database → Reports) for connection errors, pool exhaustion, or query latency regressions during this window.

- [ ] **Step 3: `[HUMAN]` After 7 days with no rollback needed, decommission Neon**

Delete the Neon project (or downgrade to free tier if keeping a cold copy is preferred — your call, not a correctness requirement). Delete the local `farmsmart-neon-data.dump` file from Task 8.

- [ ] **Step 4: Commit the ADR status update**

```bash
git add docs/adr/ADR-003.md
git commit -m "docs(adr): mark ADR-003 Accepted post-cutover"
```
