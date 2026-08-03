#!/usr/bin/env bash
# Replay the complete database migration history (Drizzle + Supabase) into a
# disposable, ephemeral local Supabase instance and run the full verification
# suite: pgTAP assertions + the api-server test suite against the throwaway DB.
#
# Safe to run in CI: the instance is stopped (without backup) on exit via the
# trap, so nothing leaks between runs.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

WORKDIR="${RUNNER_TEMP:-/tmp}/farmsmart-supabase"

TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

cleanup() {
  pnpm exec supabase --workdir "$WORKDIR" stop --no-backup || true
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/supabase/migrations"
cp "$ROOT/supabase/config.toml" "$WORKDIR/supabase/config.toml"

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
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate

# 3. Replay the Supabase-managed migrations (00001-00003) into the same DB.
pnpm exec supabase db push --db-url "$TEST_DATABASE_URL" --include-all

# 4. Run pgTAP assertions against the fully-migrated disposable DB.
pnpm exec supabase test db --db-url "$TEST_DATABASE_URL" "$ROOT/supabase/tests"

# 5. Run the api-server test suite against the disposable DB.
# ACCOUNTING_ENCRYPTION_KEY (artifacts/api-server/src/lib/accounting/crypto.ts)
# is required at call time by encryptToken(), which sensor-accounts.test.ts
# exercises for real against this disposable DB -- a fixed, non-secret,
# 32+ char test-only value (never used against any real credential).
CI=true \
REQUIRE_TEST_DATABASE=true \
TEST_DATABASE_URL="$TEST_DATABASE_URL" \
DATABASE_URL="$TEST_DATABASE_URL" \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
ACCOUNTING_ENCRYPTION_KEY="test-only-disposable-ci-key-not-a-real-secret-32chars" \
pnpm --filter @workspace/api-server run test
