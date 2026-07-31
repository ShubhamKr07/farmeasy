# Technical Review Foundation: CI And Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish repeatable tests, full migration replay, isolated staging infrastructure, and exact-commit promotion before any technical-review remediation reaches production.

**Architecture:** GitHub Actions validates Node, Python, Drizzle, and Supabase changes against disposable infrastructure. A separate Supabase project and Render staging services mirror the current production topology without changing production service types. Staging deploys only a CI-tested SHA; production promotion uses the same SHA after manual approval.

**Tech Stack:** GitHub Actions, Supabase CLI 2.109.1, PostgreSQL 17, pnpm 11.17.0, Node 22, uv, Render CLI, Playwright.

## Global Constraints

- This plan executes before all four remediation releases.
- Do not point CI or staging tests at production Supabase or Render resources.
- Apply Drizzle migrations before Supabase migrations because `supabase/migrations/00001_custom_access_token_hook.sql` depends on `public.users` and `public.user_role` created by Drizzle.
- Keep production auto-deploy enabled while authoring on a branch. Immediately before first authorized Foundation merge/push to `main`, disable it for all production services, record last-good SHAs, and verify no deploy starts. Never push Foundation commits to `main` between disablement checks.
- Never weaken branch protection as routine rollback; use manual break-glass workflow with protected environment approval.
- Do not modify unrelated current worktree changes in `.gitignore`, `.opencode/`, `artifacts/farmeasy/package.json`, or `pnpm-lock.yaml` unless the corresponding task explicitly requires that file and the existing changes are reconciled first.

---

### Task 1: Record staging and promotion architecture

**Files:**

- Create: `docs/adr/ADR-004.md`
- Modify: `docs/adr/ADR-003.md:25-29`
- Create: `docs/runbooks/staging-bootstrap.md`

**Interfaces:**

- Consumes: ADR-003 database connection policy.
- Produces: authoritative names, ownership, isolation, retention, and promotion rules used by workflows and `render.yaml`.

- [ ] **Step 1: Write ADR-004.** Record these decisions exactly:
  - One separate Supabase staging project; no production data copy.
  - Staging Render services: `farmsmart-api-staging`, `farmsmart-dashboard-staging`, `farmsmart-recommender-staging`.
  - Staging keeps current public recommender/web-dashboard topology until Release 3 performs blue-green conversion.
  - Database runtime uses transaction pooler; migrations use session pooler.
  - Production receives only the exact SHA that passed CI and staging.
  - Staging data may be reset; production migrations remain forward-only.

- [ ] **Step 2: Amend ADR-003.** Keep Supabase provider and connection decisions accepted; mark only its single-environment sentence as superseded by ADR-004.

- [ ] **Step 3: Write bootstrap runbook.** Include required staging secrets and variables:

```text
STAGING_DATABASE_URL
STAGING_DATABASE_URL_DIRECT
STAGING_DATABASE_CA_CERT
STAGING_SUPABASE_URL
STAGING_SUPABASE_ANON_KEY
STAGING_SUPABASE_SERVICE_ROLE_KEY
STAGING_API_URL
STAGING_DASHBOARD_URL
STAGING_TEST_EMAIL_DOMAIN
STAGING_TEST_PASSWORD
STAGING_MAILBOX_API_TOKEN
RENDER_API_KEY
RENDER_WORKSPACE_ID
RENDER_STAGING_API_SERVICE_ID
RENDER_STAGING_DASHBOARD_SERVICE_ID
RENDER_STAGING_RECOMMENDER_SERVICE_ID
PRODUCTION_DATABASE_URL_DIRECT
PRODUCTION_DATABASE_CA_CERT
RENDER_PRODUCTION_API_SERVICE_ID
RENDER_PRODUCTION_DASHBOARD_SERVICE_ID
RENDER_PRODUCTION_RECOMMENDER_SERVICE_ID
PRODUCTION_API_URL
PRODUCTION_DASHBOARD_URL
```

Create protected GitHub `staging` and `production` environments. Store URLs, workspace ID, and service IDs as environment variables; store database URLs, CA certificates, passwords, mailbox token, service-role keys, and Render API key as environment secrets. Require reviewers for `production` and disallow self-review when repository plan supports it.

- [ ] **Step 4: Review security boundary.** Verify no `SUPABASE_SERVICE_ROLE_KEY` appears in any `VITE_*` or `EXPO_PUBLIC_*` variable.

- [ ] **Step 5: Commit.**

```bash
git add docs/adr/ADR-003.md docs/adr/ADR-004.md docs/runbooks/staging-bootstrap.md
git commit -m "docs(adr): define staging and promotion topology"
```

### Task 2: Provision and configure hosted staging Supabase

**Files:**

- Modify: `docs/runbooks/staging-bootstrap.md`
- Create: `scripts/ci/verify-staging-supabase.mjs`

**Interfaces:**

- Produces one hosted Supabase staging project with Auth, SMTP, redirect, hook, Data API, Storage, and GitHub environment configuration verified before application staging deploys.

- [ ] **Step 1: Create hosted project.** Use PostgreSQL 17 and closest available region to Render Oregon. Record project ref and URLs in protected GitHub `staging` environment, never repository files.

- [ ] **Step 2: Configure Auth.** Set staging Site URL, dashboard callback URL, mobile deep-link callback, email/password provider, Google OAuth staging callback, and custom SMTP/test inbox capable of retrieving signup OTPs.

- [ ] **Step 3: Apply schema in correct order.**

```bash
CA_FILE="${RUNNER_TEMP:-/tmp}/staging-db-ca.pem"
install -m 600 /dev/null "$CA_FILE"
printf '%s' "$STAGING_DATABASE_CA_CERT" > "$CA_FILE"
PGSSLROOTCERT="$CA_FILE" DATABASE_CA_CERT="$STAGING_DATABASE_CA_CERT" \
  DATABASE_URL="$STAGING_DATABASE_URL_DIRECT" pnpm --filter @workspace/db run db:migrate
PGSSLROOTCERT="$CA_FILE" \
  pnpm exec supabase db push --db-url "$STAGING_DATABASE_URL_DIRECT"
```

- [ ] **Step 4: Register custom access-token hook** as `pg-functions://postgres/public/custom_access_token_hook` in staging Auth hooks.

- [ ] **Step 5: Configure Data API.** Expose only intended schemas; confirm public-schema grants/RLS match current migration state. Do not expose `auth`, `private`, or `storage` schemas as application APIs.

- [ ] **Step 6: Configure Storage.** Verify `media` bucket exists with current pre-Release-1 public setting and 5 MiB MIME restrictions. Do not flip privacy in foundation work.

- [ ] **Step 7: Write verifier.** `verify-staging-supabase.mjs` must create a unique Auth test user, retrieve OTP through test inbox, verify claims hook, confirm profile/schema/bucket existence, and delete test user plus uploaded object.

- [ ] **Step 8: Run verifier.**

```bash
STAGING_SUPABASE_URL="$STAGING_SUPABASE_URL" \
STAGING_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
STAGING_SUPABASE_SERVICE_ROLE_KEY="$STAGING_SUPABASE_SERVICE_ROLE_KEY" \
STAGING_TEST_EMAIL_DOMAIN="$STAGING_TEST_EMAIL_DOMAIN" \
STAGING_TEST_PASSWORD="$STAGING_TEST_PASSWORD" \
STAGING_MAILBOX_API_TOKEN="$STAGING_MAILBOX_API_TOKEN" \
node scripts/ci/verify-staging-supabase.mjs
```

Before Release 1, verifier creates Auth user, retrieves OTP, inserts temporary `public.users` profile with service role, refreshes session to verify custom role claim, then deletes profile/Auth user. It does not expect profile trigger that Release 1 has not installed yet.

- [ ] **Step 9: Commit.**

```bash
git add docs/runbooks/staging-bootstrap.md scripts/ci/verify-staging-supabase.mjs
git commit -m "test(supabase): verify hosted staging configuration"
```

### Task 3: Make every existing test suite deterministic

**Files:**

- Modify: `package.json:5-23`
- Modify: `artifacts/api-server/package.json:6-13`
- Modify: `artifacts/farmeasy/package.json`
- Modify: `artifacts/api-server/src/tests/metrics/metrics.test.ts:18-45`
- Modify: `artifacts/api-server/src/tests/metrics/parity.test.ts:14-33`
- Modify: `supabase/config.toml:67-71`
- Modify: `pnpm-lock.yaml`
- Create: `artifacts/api-server/scripts/run-tests.mjs`
- Create: `artifacts/farmeasy/scripts/run-tests.mjs`

**Interfaces:**

- Produces root commands `test:node`, `test:python`, and `test`; API test command discovers every `src/**/*.test.ts` and fails if DB integration is requested without `TEST_DATABASE_URL`.

- [ ] **Step 1: Capture current behavior.**

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/farmeasy run test
uv run --directory artifacts/recommender-svc pytest -v
```

Expected baseline: API unit tests pass while DB suites skip; declared FarmEasy command currently fails on modern Node; recommender tests pass.

- [ ] **Step 2: Pin package manager and fix scripts.** Add:

```json
{
  "packageManager": "pnpm@11.17.0",
  "scripts": {
    "test:node": "pnpm --filter @workspace/api-server run test && pnpm --filter @workspace/farmeasy run test",
    "test:python": "uv run --directory artifacts/recommender-svc pytest -v",
    "test": "pnpm run test:node && pnpm run test:python"
  }
}
```

Set package test scripts to deterministic Node runners:

```json
"test": "node scripts/run-tests.mjs"
```

Each runner uses `node:fs/promises.glob` to collect every `**/*.test.ts` below its package, sorts paths, prints count, fails when zero files match, and invokes Node with `--import tsx/esm --test`. API adds `--test-concurrency=1`; FarmEasy includes both `utils/` and planned `hooks/` tests. Do not rely on shell `**` expansion.

API runner process arguments:

```js
["--import", "tsx/esm", "--test", "--test-concurrency=1", ...testFiles];
```

- [ ] **Step 3: Make explicitly requested DB suites fail closed.** Keep suites skipped when no test database is requested, but fail when CI integration job opts in without a URL:

```ts
const TEST_DB = process.env.TEST_DATABASE_URL;
const REQUIRE_TEST_DB = process.env.REQUIRE_TEST_DATABASE === "true";

if (REQUIRE_TEST_DB && !TEST_DB) {
  throw new Error(
    "TEST_DATABASE_URL is required when REQUIRE_TEST_DATABASE=true",
  );
}

describe("...", { skip: !TEST_DB }, () => {
  // Existing DB-backed tests.
});
```

`node-tests` intentionally omits `REQUIRE_TEST_DATABASE`, so DB suites skip there. Only `database-integration` sets `REQUIRE_TEST_DATABASE=true` and must fail if URL is absent.

- [ ] **Step 4: Resolve missing Supabase seed.** Set `seed.enabled = false` in `supabase/config.toml`; this repository uses explicit fixtures, not `supabase/seed.sql`.

- [ ] **Step 5: Run fixed local suites.**

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/farmeasy run test
uv run --directory artifacts/recommender-svc pytest -v
pnpm run typecheck
```

- [ ] **Step 6: Commit.** Stage only intended package changes after reconciling pre-existing edits.

```bash
git add package.json artifacts/api-server/package.json artifacts/farmeasy/package.json artifacts/api-server/scripts/run-tests.mjs artifacts/farmeasy/scripts/run-tests.mjs artifacts/api-server/src/tests/metrics/metrics.test.ts artifacts/api-server/src/tests/metrics/parity.test.ts supabase/config.toml pnpm-lock.yaml
git commit -m "test: make workspace suites deterministic"
```

### Task 4: Replay complete database history in disposable Supabase

**Files:**

- Create: `scripts/ci/test-disposable-supabase.sh`
- Create: `supabase/tests/00001_foundation.sql`
- Modify: `lib/db/scripts/migrate.mjs:22`
- Modify: `lib/db/drizzle.config.ts:14-18`

**Interfaces:**

- Produces: one command that starts isolated Supabase, applies Drizzle then Supabase migrations, runs DB tests, and always stops containers.

- [ ] **Step 1: Verify hosted history before standardizing runtime configuration.** Run against staging and production:

```sql
select
  to_regclass('drizzle.__drizzle_migrations') as runtime_history,
  to_regclass('public.__drizzle_migrations') as config_only_history;

select count(*) as migration_count, max(created_at) as latest_migration
from drizzle.__drizzle_migrations;
```

Expected current state: `drizzle.__drizzle_migrations` exists with 14 rows and `public.__drizzle_migrations` is absent. Abort if only `public` exists or both histories diverge; never rename, copy, truncate, or recreate hosted history automatically. Keep Supabase CLI history separately in `supabase_migrations.schema_migrations`.

- [ ] **Step 2: Make migrator and generator agree.** Runtime `migrate.mjs` must explicitly use:

```js
await migrate(db, {
  migrationsFolder: path.resolve(__dirname, "../drizzle"),
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
});
```

Set the same table/schema in `drizzle.config.ts`; configuration must not imply a second `public` history.

- [ ] **Step 3: Write baseline pgTAP migration-order assertion.** `supabase/tests/00001_foundation.sql` runs in a transaction and asserts `drizzle.__drizzle_migrations` exists with 14 rows, `public.users`, `public.user_role`, `public.custom_access_token_hook(jsonb)`, `media` bucket, and three current rows in `supabase_migrations.schema_migrations`; finish and roll back.

- [ ] **Step 4: Write shell script with cleanup trap.**

```bash
#!/usr/bin/env bash
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

pnpm exec supabase --workdir "$WORKDIR" start
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate
pnpm exec supabase db push --db-url "$TEST_DATABASE_URL" --include-all
pnpm exec supabase test db --db-url "$TEST_DATABASE_URL" "$ROOT/supabase/tests"
CI=true REQUIRE_TEST_DATABASE=true TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
  pnpm --filter @workspace/api-server run test
```

- [ ] **Step 5: Execute locally.**

```bash
bash scripts/ci/test-disposable-supabase.sh
```

Expected: clean migration replay and zero skipped API DB tests.

- [ ] **Step 6: Commit.**

```bash
git add scripts/ci/test-disposable-supabase.sh supabase/tests/00001_foundation.sql lib/db/scripts/migrate.mjs lib/db/drizzle.config.ts
git commit -m "test(db): replay full schema in disposable Supabase"
```

### Task 5: Add required CI workflow

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces one stable `required` job for branch protection.

- [ ] **Step 1: Create CI jobs:** `quality`, `node-tests`, `database-integration`, `recommender`, `dependency-audit`, `blueprint`, and aggregate `required`.

- [ ] **Step 2: Pin runtime versions.** Use `ubuntu-24.04`, Node `22.23.2`, pnpm `11.17.0`, Supabase CLI dependency exactly `2.109.1`, uv `0.11.26`, and Render CLI `2.22.0` with checksum below. Pin actions to immutable SHAs: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node `820762786026740c76f36085b0efc47a31fe5020`, pnpm setup `0ebf47130e4866e96fce0953f49152a61190b271`, setup-uv `c771a70e6277c0a99b617c7a806ffedaca235ff9`, upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, and download-artifact `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`.

- [ ] **Step 3: Implement exact quality commands.**

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
git diff --exit-code -- lib/api-client-react/src/generated lib/api-zod/src/generated
pnpm run typecheck
```

- [ ] **Step 4: Implement tests.**

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/farmeasy run test
bash scripts/ci/test-disposable-supabase.sh
uv sync --directory artifacts/recommender-svc --locked
uv run --directory artifacts/recommender-svc pytest -v
```

`node-tests` runs first two commands without database opt-in. `database-integration` runs the disposable script, whose API invocation sets `REQUIRE_TEST_DATABASE=true`.

- [ ] **Step 5: Add audit reporting.** Initially upload npm/Python audit reports without making `required` fail; Task 6 promotes them after remediation.

```bash
pnpm audit --prod --json > npm-audit.json || true
uv export --directory artifacts/recommender-svc --locked --no-dev --format requirements.txt --output-file recommender-requirements.txt
uvx --from pip-audit pip-audit -r recommender-requirements.txt -f json -o python-audit.json || true
```

- [ ] **Step 6: Add Render Blueprint validation.**

Install checksum-pinned Render CLI before validation:

```bash
RENDER_VERSION=2.22.0
curl -fsSLo /tmp/render.zip "https://github.com/render-oss/cli/releases/download/v${RENDER_VERSION}/cli_${RENDER_VERSION}_linux_amd64.zip"
echo "6cdcd11897b7bd7e673317e6f4aaf041b654d818444f3b1efec7240a835f79ec  /tmp/render.zip" | sha256sum -c -
unzip -q /tmp/render.zip -d /tmp/render-cli
sudo install /tmp/render-cli/cli_v2.22.0 /usr/local/bin/render
```

```bash
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

- [ ] **Step 7: Add grouped Dependabot updates** for npm, GitHub Actions, and Python/uv-supported dependency manifests.

- [ ] **Step 8: Commit.**

```bash
git add .github/workflows/ci.yml .github/dependabot.yml package.json pnpm-lock.yaml
git commit -m "ci: add required workspace validation"
```

### Task 6: Remediate audit baseline and enforce high severity gate

**Files:**

- Modify: dependency manifests identified by reports
- Modify: `pnpm-lock.yaml`
- Modify: `artifacts/recommender-svc/uv.lock`
- Modify: `.github/workflows/ci.yml`
- Modify: `pnpm-workspace.yaml`
- Create: `docs/security/dependency-audit-baseline.md`
- Create: `docs/security/dependency-audit-allowlist.json`
- Create: `scripts/ci/check-dependency-audit.mjs`

- [ ] **Step 1: Generate fresh reports.**

```bash
pnpm audit --prod --audit-level high
uv export --directory artifacts/recommender-svc --locked --no-dev --format requirements.txt --output-file /tmp/recommender-requirements.txt
uvx --from pip-audit pip-audit -r /tmp/recommender-requirements.txt
```

- [ ] **Step 2: Upgrade direct dependencies first, then use the narrowest pnpm overrides for unresolved transitives.** Do not use blanket `pnpm audit --fix --force`.

- [ ] **Step 3: Add machine-readable, time-bounded exceptions.** JSON allowlist entries contain ecosystem, exact advisory ID, dependency path, owner, rationale, acceptance date, and expiry within 30 days. Validation script reads npm/Python JSON reports, subtracts only exact unexpired entries, rejects duplicate/expired/malformed entries, and fails on every remaining high/critical advisory. Mirror accepted npm GHSA IDs under pnpm `auditConfig.ignoreGhsas`; CVE aliases and severity-wide suppression are invalid. Never use `--ignore-unfixable`.

```yaml
auditConfig:
  ignoreGhsas:
    # Add only accepted, documented GHSA identifiers.
```

- [ ] **Step 4: Turn `dependency-audit` into required failure.** Generate both reports, run `node scripts/ci/check-dependency-audit.mjs`, and assert every `ignoreGhsas` value has one unexpired JSON record so native pnpm suppression cannot outlive approval.

- [ ] **Step 5: Verify lockfiles and all tests.**

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
uv sync --directory artifacts/recommender-svc --locked
uv run --directory artifacts/recommender-svc pytest -v
```

- [ ] **Step 6: Commit.**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml artifacts/recommender-svc/pyproject.toml artifacts/recommender-svc/uv.lock .github/workflows/ci.yml docs/security/dependency-audit-baseline.md docs/security/dependency-audit-allowlist.json scripts/ci/check-dependency-audit.mjs
git commit -m "fix(deps): enforce production vulnerability baseline"
```

### Task 7: Provision staging services and exact-SHA deployment

**Files:**

- Modify: `render.yaml:19-113`
- Create: `.github/workflows/deploy-staging.yml`
- Create: `.github/workflows/deploy-production.yml`
- Modify: `docs/runbooks/staging-bootstrap.md`

**Interfaces:**

- Consumes ADR-004 and CI `required` job.
- Produces current-topology staging services and protected exact-SHA production promotion.

- [ ] **Step 1: Disable production auto-deploy in Render Dashboard before any foundation push.** Record last-good production SHAs and verify no service deploy starts from documentation/Blueprint commits.

- [ ] **Step 2: Add staging Render declarations** using current service types, `branch: main`, `autoDeployTrigger: off`, and staging-only `sync: false` secrets. Also encode `autoDeployTrigger: off` on existing production services. Set staging `NODE_ENV=production`, staging CORS/API URLs, staging Supabase project, and separate recommender internal key.

- [ ] **Step 3: Validate and commit Blueprint declaration.** Stop for human approval; push only when explicitly authorized. After authorized push, sync Blueprint, discover all three staging service IDs, and store them in protected GitHub staging environment before creating workflows.

```bash
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
git add render.yaml docs/runbooks/staging-bootstrap.md
git commit -m "infra(staging): declare isolated Render services"
```

- [ ] **Step 4: Create reproducible staging workflow** triggered by successful `workflow_run` for CI on `main`. Job condition must require `conclusion == 'success'`, `event == 'push'`, `head_branch == 'main'`, and `head_repository.full_name == github.repository`. Grant only `contents: read`. Set `DEPLOY_SHA` to `github.event.workflow_run.head_sha`; checkout that ref with pinned checkout action, `fetch-depth: 0`, and `persist-credentials: false`. Require `git rev-parse HEAD == DEPLOY_SHA`, fetch `origin/main`, and reject unless SHA is its ancestor. Install exact Node/pnpm/Supabase/Render versions from Tasks 5 and 7 and run `pnpm install --frozen-lockfile` before migrations. Use concurrency:

```yaml
concurrency:
  group: staging-database
  cancel-in-progress: false
```

- [ ] **Step 5: Apply staging migrations in correct order.**

```bash
CA_FILE="${RUNNER_TEMP:-/tmp}/staging-db-ca.pem"
install -m 600 /dev/null "$CA_FILE"
printf '%s' "$STAGING_DATABASE_CA_CERT" > "$CA_FILE"
PGSSLROOTCERT="$CA_FILE" DATABASE_CA_CERT="$STAGING_DATABASE_CA_CERT" \
  DATABASE_URL="$STAGING_DATABASE_URL_DIRECT" pnpm --filter @workspace/db run db:migrate
PGSSLROOTCERT="$CA_FILE" pnpm exec supabase db push --db-url "$STAGING_DATABASE_URL_DIRECT"
```

- [ ] **Step 6: Deploy staging and wait for exact SHA.**

```bash
render deploys create "$RENDER_STAGING_RECOMMENDER_SERVICE_ID" --commit "$DEPLOY_SHA" --wait --confirm -o json > recommender-deploy.json
render deploys create "$RENDER_STAGING_API_SERVICE_ID" --commit "$DEPLOY_SHA" --wait --confirm -o json > api-deploy.json
render deploys create "$RENDER_STAGING_DASHBOARD_SERVICE_ID" --commit "$DEPLOY_SHA" --wait --confirm -o json > dashboard-deploy.json
```

- [ ] **Step 7: Persist immutable deployment evidence.** Parse each JSON response and fail unless status is `live` and commit equals `DEPLOY_SHA`. Write `deploy-metadata.json` from returned service/deploy IDs, commits, statuses, `tested_sha`, triggering CI workflow run ID, staging workflow run ID, and completion timestamp. Upload with pinned `actions/upload-artifact` as `staging-deploy-$DEPLOY_SHA`, 30-day retention, and `if-no-files-found: error`. If approval exceeds retention, rerun staging; never use a “latest deploy” lookup.

- [ ] **Step 8: Smoke test staging.**

```bash
curl --fail --silent --show-error "$STAGING_API_URL/api/healthz"
curl --fail --silent --show-error "$STAGING_DASHBOARD_URL/"
```

- [ ] **Step 9: Create protected production workflow.** Trigger from successful `Deploy Staging` `workflow_run` on `main`; grant `actions: read` and `contents: read`. With pinned `actions/download-artifact`, download only artifact from `github.event.workflow_run.id`, require exactly one metadata file, and validate workflow ID, 40-character lowercase `tested_sha`, protected staging service IDs, and every recorded staging deploy as `live` at that SHA. Checkout metadata SHA with pinned checkout action, `fetch-depth: 0`, and `persist-credentials: false`; require `git rev-parse HEAD == TESTED_SHA` and ancestry to `origin/main`. Install same pinned Node/pnpm/Supabase/Render tooling and frozen dependencies before migrations. Require GitHub `production` approval and `concurrency: { group: production-deploy, cancel-in-progress: false }`.

After approval, production workflow runs:

```bash
CA_FILE="${RUNNER_TEMP:-/tmp}/production-db-ca.pem"
install -m 600 /dev/null "$CA_FILE"
printf '%s' "$PRODUCTION_DATABASE_CA_CERT" > "$CA_FILE"
PGSSLROOTCERT="$CA_FILE" DATABASE_CA_CERT="$PRODUCTION_DATABASE_CA_CERT" \
  DATABASE_URL="$PRODUCTION_DATABASE_URL_DIRECT" pnpm --filter @workspace/db run db:migrate
PGSSLROOTCERT="$CA_FILE" \
  pnpm exec supabase db push --db-url "$PRODUCTION_DATABASE_URL_DIRECT"
render deploys create "$RENDER_PRODUCTION_RECOMMENDER_SERVICE_ID" --commit "$TESTED_SHA" --wait --confirm -o json
render deploys create "$RENDER_PRODUCTION_API_SERVICE_ID" --commit "$TESTED_SHA" --wait --confirm -o json
render deploys create "$RENDER_PRODUCTION_DASHBOARD_SERVICE_ID" --commit "$TESTED_SHA" --wait --confirm -o json
curl --fail --silent --show-error "$PRODUCTION_API_URL/api/healthz"
curl --fail --silent --show-error "$PRODUCTION_DASHBOARD_URL/"
```

Validate every production deploy response as `live` at `TESTED_SHA` and retain IDs in production evidence. Do not use nested `workflow_run.head_sha`, accept arbitrary SHA input, or run migrations before exact-SHA checkout.

- [ ] **Step 10: Commit workflows before running them.** Stop for human approval; push only when explicitly authorized. Confirm production auto-deploy remains off before workflow push.

```bash
git add .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml docs/runbooks/staging-bootstrap.md
git commit -m "ci: deploy tested commits through staging"
```

- [ ] **Step 11: Run one complete staging workflow, then protected production promotion.** Verify metadata `tested_sha` equals every production deploy commit.

## Foundation Verification Gate

Run before Release 1:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
bash scripts/ci/test-disposable-supabase.sh
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

Required evidence:

- CI `required` check passes on clean branch.
- Disposable Supabase replay applies Drizzle before Supabase migrations.
- Staging deploy records exact CI-tested SHA.
- Staging uses distinct Supabase project and secrets.
- Production deployment requires protected approval.

## Rollback

- Workflow failure: rerun failed job; do not bypass `required`.
- Staging infrastructure failure: use manual Render deploy of last good staging SHA; production remains untouched.
- Production workflow failure: stop rollout and redeploy each service's recorded last-good SHA:

```bash
render deploys create "$SERVICE_ID" --commit "$LAST_GOOD_SHA" --wait --confirm -o text
```

- Database migrations remain forward-only. Redeploy a schema-compatible prior application and issue corrective migration; never edit applied migration files.
