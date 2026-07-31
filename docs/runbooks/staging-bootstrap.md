# Runbook: Bootstrap staging and production environments

This runbook stands up the GitHub protected environments, Render services, and
Supabase projects required by [ADR-004](../adr/ADR-004.md). It is the
operational counterpart to that ADR: ADR-004 decides the topology, isolation,
retention, and promotion rules; this runbook is the step-by-step to make them
real.

**Prerequisites:** Render workspace owner access, Supabase organization owner
access, and GitHub repository `admin` role (required to create protected
environments and configure required reviewers).

---

## Step 1: Create the Supabase staging project

Create a **separate** Supabase project for staging. Per ADR-004, this is a
distinct project from production — **do not** copy, clone, or branch production
data into it. Seed staging with synthetic/test fixtures only.

> **Status (2026-07-31):** Project created — `farmsmart-staging`
> (ref `jkxlbndnatkxmhpumvhh`, region `us-west-1`, Postgres 17). URL, anon key,
> and DB password collected. Drizzle + Supabase migrations applied. Custom
> access-token hook registered and verified live (`scripts/ci/verify-staging-supabase.mjs`
> passes: JWT claim, bucket, RLS checks all green). **Open TODOs, not blocking
> any Foundation task:**
> - **SMTP test inbox** (`STAGING_MAILBOX_API_TOKEN`) — no Mailtrap/Mailosaur-
>   style account exists yet. Needed only for `verify-staging-supabase.mjs`'s
>   OTP-retrieval step and Release 1 Task 2's automated signup script; not
>   needed for CI, migrations, or the deploy workflows.
> - **Google OAuth staging client** — no staging redirect URI configured yet
>   (either a new OAuth client or an added redirect on the existing
>   production one). Needed only for staging Google sign-in testing, not for
>   the rest of Foundation.
>
> **CLI gotcha for whoever touches Auth config next (Release 3/4, or the
> production hook if it's ever re-registered):** `supabase config push` for a
> `[auth.hook.*]` block reports `auth: updated` / `up_to_date` even when it
> silently did nothing — verified via a direct Management API read
> (`GET /v1/projects/{ref}/config/auth`) that `hook_custom_access_token_enabled`
> stayed `false` after two "successful" pushes. Worked around with a direct
> `PATCH /v1/projects/{ref}/config/auth` call. **Always verify auth hook state
> via the Management API GET after any config push that touches `[auth.hook.*]`
> — do not trust the CLI's reported status for that section.**

From the new staging project's *Project Settings → Database → Connection
string* and *Project Settings → API*, collect:

- Transaction-pooler URL (port 6543) → `STAGING_DATABASE_URL`
- Session-pooler / direct URL (port 5432, `pooler.supabase.co`) →
  `STAGING_DATABASE_URL_DIRECT`
- Database CA cert → `STAGING_DATABASE_CA_CERT`
- Project URL → `STAGING_SUPABASE_URL`
- `anon` public key → `STAGING_SUPABASE_ANON_KEY`
- `service_role` secret key → `STAGING_SUPABASE_SERVICE_ROLE_KEY`

The production Supabase project already exists (provisioned under ADR-003).
Collect the same artifacts from it for the `production` environment variables
in Step 4.

---

## Step 2: Create the Render staging services

Create three staging services on Render, mirroring production:

| Staging service | Production counterpart |
|---|---|
| `farmsmart-api-staging` | `farmsmart-api` |
| `farmsmart-dashboard-staging` | `farmsmart-dashboard` |
| `farmsmart-recommender-staging` | `farmsmart-recommender` |

Per ADR-004, staging keeps the **current public recommender / web-dashboard
topology** — do not pre-adopt the blue-green / domain-mapped topology. That
conversion happens in Release 3.

> **Status (2026-07-31):** `render.yaml` now declares the three staging
> services (`farmsmart-api-staging`, `farmsmart-dashboard-staging`,
> `farmsmart-recommender-staging`) mirroring their production counterparts
> (type, runtime, plan, region, build/start commands, health check). Each is
> pinned to `branch: main` with `autoDeployTrigger: off` for SHA-gated
> promotion. In the same change, all three **production** services had
> `autoDeploy: true` switched to `autoDeployTrigger: off`; that production
> autodeploy disable was also applied **live via the Render API** on
> 2026-07-31. Last-good production SHA at disable time: **`e97f09e`**. All
> three production services were confirmed live (healthy on `/api/healthz`,
> `/`, and `/healthz` respectively) both **before and after** the API call,
> so the disable caused no outage or redeploy.

From Render's workspace *Settings* and each service's *Info* panel, collect:

- Workspace ID → `RENDER_WORKSPACE_ID`
- `farmsmart-api-staging` service ID → `RENDER_STAGING_API_SERVICE_ID`
- `farmsmart-dashboard-staging` service ID → `RENDER_STAGING_DASHBOARD_SERVICE_ID`
- `farmsmart-recommender-staging` service ID → `RENDER_STAGING_RECOMMENDER_SERVICE_ID`
- `farmsmart-api-staging` public URL → `STAGING_API_URL`
- `farmsmart-dashboard-staging` public URL → `STAGING_DASHBOARD_URL`

And for the existing production services:

- `farmsmart-api` service ID → `RENDER_PRODUCTION_API_SERVICE_ID`
- `farmsmart-dashboard` service ID → `RENDER_PRODUCTION_DASHBOARD_SERVICE_ID`
- `farmsmart-recommender` service ID → `RENDER_PRODUCTION_RECOMMENDER_SERVICE_ID`
- `farmsmart-api` public URL → `PRODUCTION_API_URL`
- `farmsmart-dashboard` public URL → `PRODUCTION_DASHBOARD_URL`

> **Status (2026-07-31):** No registered Render "Blueprint" object exists for
> this workspace (`GET /v1/blueprints` returns `[]`) — the original 3
> production services were created directly, not through Render's Blueprint
> sync feature, so pushing `render.yaml` does not auto-create anything. The 3
> staging services were created directly via `render services create` (using
> `--from <production-service-id>` failed with `IP allow list is only
> available for Enterprise workspaces`, so each was created from explicit
> flags matching its production counterpart instead), then deployed and
> verified live:
>
> | Service | ID | URL | Health check |
> |---|---|---|---|
> | `farmsmart-api-staging` | `srv-d9m9928ae00c73bmc7k0` | https://farmsmart-api-staging.onrender.com | `200` on `/api/healthz` |
> | `farmsmart-dashboard-staging` | `srv-d9m9958ae00c73bmccvg` | https://farmsmart-dashboard-staging.onrender.com | `200` on `/` |
> | `farmsmart-recommender-staging` | `srv-d9m997p5efls73cnvch0` | https://farmsmart-recommender-staging.onrender.com | `200` on `/healthz` |
>
> Render workspace ID: `tea-d943g4u7r5hc73e402tg` (**not** the Supabase
> organization ID `wmwypyeabwpqsekvlwld` — an earlier `RENDER_WORKSPACE_ID`
> reference in this session conflated the two; corrected here, no committed
> file was affected since it was only used in a `render blueprints validate`
> command, not written to any tracked file).
>
> Production service IDs for reference: `farmsmart-api` =
> `srv-d944vmkvikkc73bj51j0`, `farmsmart-dashboard` =
> `srv-d944vpnlk1mc73afgv9g`, `farmsmart-recommender` =
> `srv-d94cakflk1mc73avi9n0`.
>
> Env vars set on all 3 staging services via direct `PUT /v1/services/{id}/env-vars`
> calls (no CLI support for this — `render services update` has no `--env-var`
> flag, only `render services create` does): staging Supabase URL/DB
> connection strings/service-role key (real values, already live from Task
> 2), cross-service URLs (now known since all 3 exist), freshly generated
> `ACCOUNTING_ENCRYPTION_KEY` and `RECOMMENDER_INTERNAL_KEY` (matching pair
> across api-staging/recommender-staging), and `GEMINI_API_KEY`/
> `TAVILY_API_KEY` reused from production (third-party provider keys, not
> environment-scoped by this app's design). **Still unset, deliberately
> deferred:** `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`/`QBO_REDIRECT_URI` on
> `farmsmart-api-staging` (no staging QuickBooks sandbox app configured yet).

---

## Step 3: Create the GitHub protected environments

In the repository, go to *Settings → Environments* and create two environments:
`staging` and `production`.

- **`staging`:** no required reviewers (auto-deploys on the gated SHA from CI).
- **`production`:** add **required reviewers**, and enable **"Prevent
  self-review"** if the repository plan supports it (so the person who pushed
  the SHA cannot also approve its promotion to production).

These environments enforce the SHA-gated promotion rule from ADR-004:
production receives only the exact SHA that passed CI *and* staging.

---

## Step 4: Add environment variables and secrets

Add the configuration below to the corresponding GitHub environment
(*Settings → Environments → [environment] → Add variable / Add secret*).

**Variables** (non-sensitive — URLs, workspace ID, service IDs):

| Variable | Environment |
|---|---|
| `STAGING_SUPABASE_URL` | `staging` |
| `STAGING_SUPABASE_ANON_KEY` | `staging` |
| `STAGING_API_URL` | `staging` |
| `STAGING_DASHBOARD_URL` | `staging` |
| `STAGING_TEST_EMAIL_DOMAIN` | `staging` |
| `RENDER_WORKSPACE_ID` | `staging` and `production` |
| `RENDER_STAGING_API_SERVICE_ID` | `staging` |
| `RENDER_STAGING_DASHBOARD_SERVICE_ID` | `staging` |
| `RENDER_STAGING_RECOMMENDER_SERVICE_ID` | `staging` |
| `RENDER_PRODUCTION_API_SERVICE_ID` | `production` |
| `RENDER_PRODUCTION_DASHBOARD_SERVICE_ID` | `production` |
| `RENDER_PRODUCTION_RECOMMENDER_SERVICE_ID` | `production` |
| `PRODUCTION_API_URL` | `production` |
| `PRODUCTION_DASHBOARD_URL` | `production` |

**Secrets** (sensitive — DB URLs, CA certs, passwords, mailbox token,
service-role keys, Render API key):

| Secret | Environment |
|---|---|
| `STAGING_DATABASE_URL` | `staging` |
| `STAGING_DATABASE_URL_DIRECT` | `staging` |
| `STAGING_DATABASE_CA_CERT` | `staging` |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | `staging` |
| `STAGING_TEST_PASSWORD` | `staging` |
| `STAGING_MAILBOX_API_TOKEN` | `staging` |
| `RENDER_API_KEY` | `staging` and `production` |
| `PRODUCTION_DATABASE_URL_DIRECT` | `production` |
| `PRODUCTION_DATABASE_CA_CERT` | `production` |

### Security boundary: never expose service-role keys to client bundles

> ⚠️ **`SUPABASE_SERVICE_ROLE_KEY` (and any service-role key) must never appear
> in any `VITE_*`- or `EXPO_PUBLIC_*`-prefixed variable.** Those prefixes cause
> the value to be inlined into client-side bundles (Vite for the web dashboard,
> Expo for the alpha app), where it is trivially extractable by anyone who can
> load the page or install the app. A leaked service-role key bypasses Row Level
> Security entirely — it is full admin access to the database.
>
> Service-role keys live only in server-side secrets
> (`STAGING_SUPABASE_SERVICE_ROLE_KEY`, consumed by `farmsmart-api-staging` /
> `farmsmart-recommender-staging` / migration runners). Client bundles may
> consume **only** the `anon` key (`STAGING_SUPABASE_ANON_KEY`), which is safe
> to publish because RLS gates everything it can reach.
>
> Verify this before closing the runbook: grep the configured variables for any
> `VITE_SUPABASE_SERVICE_ROLE_KEY` or `EXPO_PUBLIC_*SERVICE_ROLE*` — the result
> must be empty.

---

## Step 5: Verify the SHA-gated promotion path

Confirm, end to end, that production cannot receive anything other than the
exact SHA that passed CI and staging:

1. A commit lands on `main`; CI runs and green-tags a specific SHA.
2. The promotion workflow deploys that SHA to the `staging` environment and to
   the three Render staging services; staging checks pass.
3. A reviewer (not the SHA's author, per Step 3's self-review guard) approves
   promotion of that same SHA to the `production` environment.
4. The workflow deploys the identical SHA to the three Render production
   services and runs migrations via `PRODUCTION_DATABASE_URL_DIRECT` (session
   pooler) — forward-only, per ADR-004.

If any step rebuilds, re-resolves "latest," or deploys a different SHA, the
gate is broken and must be fixed before proceeding.

---

## Step 6: Deploy workflows (exact-SHA staging and production promotion)

Two GitHub Actions workflows implement the SHA-gated promotion path described
in Step 5. Both are pinned to the same immutable action SHAs and tool versions
as `ci.yml`, and both refuse to deploy anything other than an explicit,
already-CI-tested commit.

### `Deploy Staging` (`.github/workflows/deploy-staging.yml`)

**Purpose:** promote the exact CI-tested SHA to the three staging Render
services (`recommender` → `api` → `dashboard`) and the staging Supabase
database, then record immutable evidence so production can promote the same
SHA without re-resolving anything.

**Trigger:** `workflow_run` on the `CI` workflow, type `completed`. The job's
`if:` requires `conclusion == 'success'`, `event == 'push'`,
`head_branch == 'main'`, and `head_repository.full_name == github.repository`
— so it only fires for a successful CI run on `main` in this repository
(never a PR, never a fork). It runs in the `staging` GitHub environment and
holds concurrency group `staging-database` (`cancel-in-progress: false`) so
two staging deploys can never mutate the staging database concurrently.

**SHA handling:** `DEPLOY_SHA` is set once to
`github.event.workflow_run.head_sha`. That ref is checked out
(`fetch-depth: 0`, `persist-credentials: false`), then asserted to equal
`git rev-parse HEAD` **and** to be an ancestor of `origin/main` before any
mutation. Every Render deploy pins it via `--commit "$DEPLOY_SHA"`. There is
no `workflow_dispatch` and no arbitrary SHA input.

**Validation & evidence:** each `render deploys create ... --wait -o json`
response is re-checked to be `status == "live"` with `commit == DEPLOY_SHA`.
A `deploy-metadata.json` (service IDs, deploy IDs, commits, statuses,
`tested_sha`, the triggering CI run id, the staging run id, and a completion
timestamp) is uploaded as artifact `staging-deploy-$DEPLOY_SHA`
(`actions/upload-artifact`, 30-day retention, `if-no-files-found: error`).
Staging smoke tests (`/api/healthz`, `/`) run last. If the artifact expires
before production promotes, re-run staging — never look up "latest deploy".

### `Deploy Production` (`.github/workflows/deploy-production.yml`)

**Purpose:** promote the *exact* SHA that passed CI **and** staging to the
three production Render services (`recommender` → `api` → `dashboard`) and the
production Supabase database, forward-only.

**Trigger:** `workflow_run` on the `Deploy Staging` workflow, type `completed`,
with the same success/push/main/same-repository predicates. Two jobs:

1. **`validate-staging-evidence`** (runs in the `staging` environment, which has
   no required reviewers, to read the protected staging service IDs): downloads
   the staging run's artifact with `actions/download-artifact` scoped to
   `github.event.workflow_run.id`, requires exactly one `deploy-metadata.json`,
   and validates the `tested_sha` is a 40-char lowercase hex SHA, the metadata's
   `staging_workflow_run_id` matches the triggering run, every recorded staging
   deploy is `live` at that SHA, and the recorded service IDs match the
   protected `RENDER_STAGING_*_SERVICE_ID` values. It exposes `tested_sha` as a
   job output. This read-only validation runs *before* any human is asked to
   approve, so bad evidence fails fast without consuming an approval.
2. **`deploy-production`** (`environment: production`, gated by that
   environment's required reviewers; `concurrency: production-deploy`,
   `cancel-in-progress: false`): checks out `TESTED_SHA` (from the artifact,
   **not** `workflow_run.head_sha`), asserts it equals `git rev-parse HEAD` and
   is an ancestor of `origin/main`, installs dependencies, applies migrations,
   deploys each service pinned to `--commit "$TESTED_SHA"`, validates every
   response as `live` at `TESTED_SHA`, and runs production smoke tests.

**Approval model:** the workflow contains **no review-gating logic of its own**.
The human gate is the GitHub `production` environment's required-reviewer
protection rule configured in Step 3 — that is the only approval mechanism.
The SHA is recovered from the immutable artifact, never from a "latest" lookup
and never re-resolved from `workflow_run.head_sha`.

> **Status (2026-07-31):** Both workflow files are committed locally only
> (`ci: deploy tested commits through staging`) and **not pushed**, awaiting
> human authorization per Task 7 Step 10. Production auto-deploy remains `off`
> (set in Step 2). These workflows must be pushed only after explicit approval;
> do not run them until the protected environments and all secrets/variables
> from Steps 3–4 are configured.

---

## Reference: full variable and secret list

The complete set of 23 names configured by this runbook, in one place for
audit:

**Staging environment (12):**

```text
STAGING_DATABASE_URL                 (secret)
STAGING_DATABASE_URL_DIRECT          (secret)
STAGING_DATABASE_CA_CERT             (secret)
STAGING_SUPABASE_URL                 (variable)
STAGING_SUPABASE_ANON_KEY            (variable)
STAGING_SUPABASE_SERVICE_ROLE_KEY    (secret)
STAGING_API_URL                      (variable)
STAGING_DASHBOARD_URL                (variable)
STAGING_TEST_EMAIL_DOMAIN            (variable)
STAGING_TEST_PASSWORD                (secret)
STAGING_MAILBOX_API_TOKEN            (secret)
RENDER_STAGING_API_SERVICE_ID        (variable)
RENDER_STAGING_DASHBOARD_SERVICE_ID  (variable)
RENDER_STAGING_RECOMMENDER_SERVICE_ID(variable)
```

**Production environment (9):**

```text
PRODUCTION_DATABASE_URL_DIRECT       (secret)
PRODUCTION_DATABASE_CA_CERT          (secret)
RENDER_PRODUCTION_API_SERVICE_ID     (variable)
RENDER_PRODUCTION_DASHBOARD_SERVICE_ID(variable)
RENDER_PRODUCTION_RECOMMENDER_SERVICE_ID(variable)
PRODUCTION_API_URL                   (variable)
PRODUCTION_DASHBOARD_URL             (variable)
```

**Shared across both environments (2):**

```text
RENDER_API_KEY                       (secret)
RENDER_WORKSPACE_ID                  (variable)
```
