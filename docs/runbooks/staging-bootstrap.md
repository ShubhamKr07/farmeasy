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
> (ref `jkxlbndnatkxmhpumvhh`, region `us-west-1`, Postgres 17). URL and anon
> key collected. **Open TODOs, not yet blocking Tasks 3/5/6:**
> - **DB direct connection string.** Supabase only shows the database
>   password once at project creation (or on manual reset); it is not
>   retrievable via API/CLI after the fact. Reset it from *Project Settings →
>   Database → Reset database password* and use it to build
>   `STAGING_DATABASE_URL_DIRECT` before running Step 3 of Foundation Task 2
>   (schema apply) or Foundation Task 4 (disposable-replay history check).
> - **SMTP test inbox** (`STAGING_MAILBOX_API_TOKEN`) — no Mailtrap/Mailosaur-
>   style account exists yet. Needed only for `verify-staging-supabase.mjs`'s
>   OTP-retrieval step and Release 1 Task 2's automated signup script; not
>   needed for CI, migrations, or the deploy workflows.
> - **Google OAuth staging client** — no staging redirect URI configured yet
>   (either a new OAuth client or an added redirect on the existing
>   production one). Needed only for staging Google sign-in testing, not for
>   the rest of Foundation.

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
