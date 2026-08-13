#!/usr/bin/env bash
# Replay the complete database migration history (Drizzle + Supabase) into a
# disposable, ephemeral local Supabase instance and run the full verification
# suite: pgTAP assertions + the api-server test suite against the throwaway DB.
#
# Safe to run in CI: the instance is stopped (without backup) on exit via the
# trap, so nothing leaks between runs.
#
# Local troubleshooting: if `supabase start` below reports unhealthy services
# (analytics, vector, realtime, storage, pg-meta, studio) and the script tears
# down before reaching migrations, this repo's suite doesn't actually need
# those six — only db/auth/kong/rest are used. On a memory-constrained Docker
# Desktop VM (observed at the 8GB setting) those unused sidecars can start
# genuinely healthy internally (their own logs show ready) but still fail the
# CLI's health-check probe under memory pressure. Confirmed CI is NOT at risk:
# this exact job passes consistently on ubuntu-latest GitHub Actions runners,
# which run Docker natively (no Docker-Desktop-VM memory ceiling). As a
# LOCAL-ONLY workaround, run with `--ignore-health-check` appended to the
# `supabase start` invocation below — verified to produce an identical
# pipeline result (pgTAP 8/50 PASS, api-server 246/246). Do not add this flag
# to the command CI runs; it masks a real health-check failure if one ever
# occurs for db/auth/kong/rest.
#
# ISOLATION (per-worktree/agent): supabase/config.toml's `project_id` is the
# prefix the Supabase CLI uses for every Docker container/network/volume it
# creates (supabase_db_<project_id>, supabase_kong_<project_id>, ...). The
# committed config.toml hard-codes a single project_id, so copying it verbatim
# means every worktree/agent running this script on the same machine names the
# SAME containers -- two concurrent runs fight over one Postgres/Kong/etc.
# stack (hit repeatedly during TEN-013 when multiple agents ran this in
# parallel). Fix below: derive a short id from this worktree's absolute path
# ($ROOT) and (a) fold it into WORKDIR so concurrent runs never share an
# on-disk workdir, and (b) rewrite project_id in the per-run copy of
# config.toml so concurrent runs never share Docker resources either. A
# sha256 prefix (not the raw path) keeps the id short, deterministic, and
# restricted to lowercase hex -- the only characters guaranteed valid in a
# Docker Compose project name. This does NOT change the migration-replay /
# pgTAP / api-server steps below, and CI already gets one unique $RUNNER_TEMP
# per job -- this is purely additive isolation for concurrent LOCAL runs.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# Unique per-worktree id -- the same worktree reuses the same id run-to-run
# (harmless: a stale container from a prior run of the SAME worktree is
# stopped/recreated exactly like a fresh one), different worktrees never
# collide. See the ISOLATION note above. sha256sum (GNU coreutils) is what
# this repo's CI already uses (ci.yml/deploy-*.yml) but isn't preinstalled on
# macOS; shasum -a 256 is the macOS/BSD equivalent but isn't guaranteed on a
# minimal Linux image. Prefer sha256sum (the CI runner's actual tool), fall
# back to shasum for local macOS dev.
if command -v sha256sum >/dev/null 2>&1; then
  WORKTREE_ID="$(printf '%s' "$ROOT" | sha256sum | cut -c1-12)"
else
  WORKTREE_ID="$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-12)"
fi

WORKDIR="${RUNNER_TEMP:-/tmp}/farmsmart-supabase-${WORKTREE_ID}"

TEST_ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
# The api-server test suite's APP connection: a real, non-BYPASSRLS
# `farmsmart_app` role (provisioned below, step 3.5), so RLS is genuinely
# exercised by every functional cross-tenant test in CI instead of being a
# silent no-op under the `postgres` superuser. `farmsmart_app_ci_only` is a
# LOCAL, EPHEMERAL, disposable-stack-only password -- it is thrown away with
# the container on every run (see the `cleanup`/`--no-backup` trap below) and
# is NEVER used against staging/prod (those rotate their own, real secret --
# see docs/runbooks/mt-m1-rls-role-rotation.md / prod-rls-role-rotation.md).
TEST_DATABASE_URL="postgresql://farmsmart_app:farmsmart_app_ci_only@127.0.0.1:54322/postgres"

cleanup() {
  pnpm exec supabase --workdir "$WORKDIR" stop --no-backup || true
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/supabase/migrations"
# Copy config.toml but rewrite project_id to the per-worktree unique id above
# (see ISOLATION note) instead of a plain `cp`, so this disposable stack's
# Docker resources never collide with another worktree's concurrent run.
sed -e "s/^project_id = .*/project_id = \"farmsmart-disposable-${WORKTREE_ID}\"/" \
  "$ROOT/supabase/config.toml" > "$WORKDIR/supabase/config.toml"

# 1. Start a disposable local Supabase stack in the isolated workdir.
pnpm exec supabase --workdir "$WORKDIR" start

# supabaseAuth.ts (artifacts/api-server/src/middlewares/supabaseAuth.ts) reads
# SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY at module *import* time, not lazily —
# so any DB-gated test file that imports a route touching that middleware
# crashes on undefined even though the test harness (createAuthenticatedTestApp)
# stubs the actual auth check and never calls the real client. Pull the
# disposable stack's own URL/service-role key so those imports succeed.
eval "$(pnpm exec supabase --workdir "$WORKDIR" status -o env \
  --override-name api.url=SUPABASE_URL \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY)"
export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY

# 2. Replay the full Drizzle migration history into the disposable DB.
# Runs as the superuser (TEST_ADMIN_DATABASE_URL): CREATE TABLE/ALTER TABLE/
# CREATE POLICY etc. all need owner/superuser privileges that farmsmart_app
# (provisioned in step 3.5, below) deliberately does not have.
DATABASE_URL="$TEST_ADMIN_DATABASE_URL" pnpm --filter @workspace/db run db:migrate

# 3. Replay the Supabase-managed migrations (00001-00003) into the same DB.
# Deliberately NO --workdir here: `db push` needs to find the REAL,
# hand-written migration files, which live at $ROOT/supabase/migrations, not
# in $WORKDIR/supabase/migrations (which stays empty — only the Drizzle
# history is Drizzle-generated; the Supabase migrations are never copied into
# $WORKDIR). It resolves the project directory by walking up from the CURRENT
# directory (still $ROOT, never `cd`ed into $WORKDIR), which correctly finds
# $ROOT/supabase/migrations. (Verified locally: adding --workdir "$WORKDIR"
# here made the CLI resolve $WORKDIR/supabase/migrations instead — empty — so
# it silently reported "Local database is up to date" having applied ZERO
# migrations, a real regression caught only by running the full pipeline
# end-to-end.) `db push --db-url` needs no Docker networking (a direct
# connection), so it never hits the project_id/network-name collision this
# script isolates against — only `test db` below does.
pnpm exec supabase db push --db-url "$TEST_ADMIN_DATABASE_URL" --include-all

# 3.5. Provision `farmsmart_app`: a real, least-privilege, NON-BYPASSRLS
# Postgres role, so the RLS policies replayed above are genuinely enforced
# against the api-server test suite's own connection (step 5) instead of
# being a silent no-op under the `postgres` superuser (which has BYPASSRLS).
# This role, password, and grant set are LOCAL to this disposable, ephemeral
# stack -- torn down with the container on every run (see the `cleanup`/
# `--no-backup` trap above) -- and are never used against staging/prod (those
# rotate their own, real secret; see docs/runbooks/mt-m1-rls-role-rotation.md).
# Grant set replicated verbatim from that runbook (the canonical, already-
# staging-verified least-privilege grant set for this role) -- do not invent a
# broader grant here. Run via the superuser connection (only a superuser/owner
# can CREATE ROLE and GRANT on every table).
psql "$TEST_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'farmsmart_app') then
    create role farmsmart_app with login password 'farmsmart_app_ci_only';
  end if;
end
$$;
grant usage on schema public to farmsmart_app;
grant select, insert, update, delete on all tables in schema public to farmsmart_app;
grant usage, select on all sequences in schema public to farmsmart_app;
alter default privileges in schema public grant select, insert, update, delete on tables to farmsmart_app;
alter default privileges in schema public grant usage, select on sequences to farmsmart_app;
grant authenticated to farmsmart_app;
SQL

# 3.6. Hard-fail guard: assert the api-server suite's APP connection
# ($TEST_DATABASE_URL, the same URL exported as TEST_DATABASE_URL/DATABASE_URL
# for step 5 below) is genuinely non-BYPASSRLS *before* any test runs. The
# functional RLS canaries in crops.test.ts/sensor-status.test.ts/demo.test.ts
# key on `pg_roles.rolbypassrls` and gracefully degrade to structural-only
# checks if it's ever true -- they do NOT hard-fail on their own if
# `farmsmart_app` silently regains BYPASSRLS or this script's wiring
# regresses to reconnect the suite as the `postgres` superuser. This step is
# the unconditional backstop: it always runs, and exits non-zero loudly if
# BYPASSRLS is true OR if the connected role isn't exactly `farmsmart_app`
# (EXPECTED_DB_ROLE catches a silent fallback to `postgres`, which is itself
# BYPASSRLS but is asserted explicitly here for a clearer failure message).
# Reuses scripts/ci/verify-db-role.mjs (the same script the staging/prod
# `verify-*-db-role.yml` workflows use) rather than a bespoke check, so there
# is exactly one implementation of "is this role safe for RLS" to keep in
# sync. Local disposable Postgres (127.0.0.1) is classified `ssl: false` by
# buildSslConfig's isLocalDatabase() -- no DB_ROLE_CHECK_INSECURE_TLS needed
# here (that flag is only for the hosted Supavisor pooler in CI/prod
# workflows).
echo "Asserting api-server APP connection (farmsmart_app) does not bypass RLS..."
DATABASE_URL="$TEST_DATABASE_URL" EXPECTED_DB_ROLE="farmsmart_app" node "$ROOT/scripts/ci/verify-db-role.mjs"

# 4. Run pgTAP assertions against the fully-migrated disposable DB.
# --workdir IS required here: `test db` spins up a Docker helper container
# attached to the project's Docker network to run pg_prove, so it must
# resolve the SAME (rewritten, per-worktree) project_id `start` used above —
# without it, the CLI falls back to cwd resolution of the ORIGINAL,
# un-rewritten $ROOT/supabase/config.toml project_id, reintroducing the exact
# Docker network-name collision this script isolates against (verified
# locally: omitting --workdir here made `test db` fail with "network
# supabase_network_supabase-db-migration not found" once project_id started
# diverging between $ROOT/supabase/config.toml and the $WORKDIR copy). The
# pgTAP test SQL directory itself is passed as an explicit positional arg
# ($ROOT/supabase/tests, the real one), independent of --workdir.
pnpm exec supabase --workdir "$WORKDIR" test db --db-url "$TEST_ADMIN_DATABASE_URL" "$ROOT/supabase/tests"

# 5. Run the api-server test suite against the disposable DB.
# ACCOUNTING_ENCRYPTION_KEY (artifacts/api-server/src/lib/accounting/crypto.ts)
# is required at call time by encryptToken(), which sensor-accounts.test.ts
# exercises for real against this disposable DB -- a fixed, non-secret,
# 32+ char test-only value (never used against any real credential).
#
# Connection split (testDatabase.ts's own convention -- see getAdminPool's
# doc comment there): TEST_DATABASE_URL/DATABASE_URL is the suite's APP
# connection (`@workspace/db`'s `db`, and every route the app under test
# hits) -- now the real non-BYPASSRLS `farmsmart_app` role, so every
# functional cross-tenant "deny" assertion in cross-tenant.test.ts/
# crops.test.ts/sensor-status.test.ts/demo.test.ts genuinely exercises RLS,
# not just the app-layer WHERE-clause filter. TEST_ADMIN_DATABASE_URL is the
# superuser, used ONLY by getAdminDb()/getAdminPool() for test-only elevated
# needs (fixture seeding/truncation, and verification reads of RLS-scoped
# tables that must see ground truth regardless of the current app.org_id/
# app.facility_id GUC) -- never by real app code.
CI=true \
REQUIRE_TEST_DATABASE=true \
TEST_DATABASE_URL="$TEST_DATABASE_URL" \
TEST_ADMIN_DATABASE_URL="$TEST_ADMIN_DATABASE_URL" \
DATABASE_URL="$TEST_DATABASE_URL" \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
ACCOUNTING_ENCRYPTION_KEY="test-only-disposable-ci-key-not-a-real-secret-32chars" \
pnpm --filter @workspace/api-server run test
