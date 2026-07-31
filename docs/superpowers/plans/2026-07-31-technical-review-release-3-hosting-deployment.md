# Technical Review Release 3: Hosting And Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace wasteful dashboard/recommender hosting with CDN static delivery and private networking, while selecting only affected services for exact-SHA manual deployment and preserving blue-green rollback.

**Architecture:** New Render resources are created because service `type` and `runtime` are immutable. Production auto-deploy stays off. Render build filters document dependencies and govern previews/future auto-deploys, while GitHub Actions independently selects affected manual deploys. Staging and production workflows switch topology together before canonical staging evidence is generated.

**Tech Stack:** Render Blueprints/CLI, Vite static output, Render CDN, FastAPI private service, GitHub protected environments.

## Global Constraints

- Complete foundation CI/staging plan, Release 1, and Release 2 first. This plan consumes API route tests/contracts and dashboard Vitest harness introduced there.
- Never convert existing Render service type/runtime in place.
- Static dashboard cannot call private hostnames; it continues calling public API URL.
- API and private recommender must remain in same Render workspace, region, and environment.
- Keep old dashboard and recommender for seven days after production cutover.
- Deploy and verify new resources before moving domains or environment variables.
- Production auto-deploy remains off; promote exact staging-tested SHA.
- Render build filters do not suppress manual or configuration-triggered deploys; workflow path selection is authoritative.
- Topology changes update `render.yaml`, both deploy workflows, protected service-ID variables, and deployment metadata schema before canonical staging run.
- Production consumes staging metadata's service selection and topology verbatim; it never recomputes changed paths.
- Blueprint sync and ad-hoc staging deploys are preflight only, never promotable evidence.

---

### Task 1: Make dashboard build static-host compatible

**Files:**

- Modify: `artifacts/admin-dashboard/vite.config.ts:7-74`
- Modify: `artifacts/admin-dashboard/package.json:6-10`
- Create: `artifacts/admin-dashboard/src/build-config.test.ts`

**Interfaces:**

- Produces `artifacts/admin-dashboard/dist/public/index.html` without requiring runtime `PORT`.

- [ ] **Step 1: Write failing config test.** Production build config succeeds with `BASE_PATH=/` and no `PORT`; development server still rejects invalid explicit port.

- [ ] **Step 2: Separate build and server config.** `PORT` is optional for `vite build`; use a validated fallback only in `server`/`preview`. Keep `BASE_PATH` required or default explicitly to `/` for production.

- [ ] **Step 3: Remove production dependency on `vite preview`.** Keep `serve` script for local smoke testing only.

- [ ] **Step 4: Build and inspect output.**

```bash
NODE_ENV=production BASE_PATH=/ pnpm --filter @workspace/admin-dashboard run build
test -f artifacts/admin-dashboard/dist/public/index.html
pnpm --filter @workspace/admin-dashboard run typecheck
```

- [ ] **Step 5: Commit.**

```bash
git add artifacts/admin-dashboard/vite.config.ts artifacts/admin-dashboard/package.json artifacts/admin-dashboard/src/build-config.test.ts
git commit -m "build(dashboard): support static production output"
```

### Task 2: Add blue-green Render static dashboard resources

**Files:**

- Modify: `render.yaml:62-87`
- Create: `docs/runbooks/staging-and-production-deploy.md`

**Interfaces:**

- Produces `farmsmart-dashboard-static-staging` and `farmsmart-dashboard-static`; old Node services remain during rollback window.

- [ ] **Step 1: Add staging static site.**

```yaml
- type: web
  runtime: static
  name: farmsmart-dashboard-static-staging
  buildCommand: npm i -g pnpm@11.17.0 && pnpm install --frozen-lockfile && pnpm --filter @workspace/admin-dashboard run build
  staticPublishPath: artifacts/admin-dashboard/dist/public
  autoDeployTrigger: off
  routes:
    - type: rewrite
      source: /*
      destination: /index.html
  headers:
    - path: /assets/*
      name: Cache-Control
      value: public, max-age=31536000, immutable
    - path: /*
      name: X-Content-Type-Options
      value: nosniff
    - path: /*
      name: X-Frame-Options
      value: DENY
```

- [ ] **Step 2: Add equivalent production static site** with production API/Supabase public variables and no custom domain yet.

- [ ] **Step 3: Validate, commit, and push declaration before resource operations.**

```bash
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
git add render.yaml docs/runbooks/staging-and-production-deploy.md
git commit -m "infra(dashboard): declare blue-green static sites"
```

Stop for human approval. Push only when explicitly authorized; Blueprint sync follows authorized push.

- [ ] **Step 4: Sync Blueprint and discover IDs.** After resources exist, record staging/production static service IDs in protected GitHub environments. Initial resource creation may build current `main`; it receives no custom domain or production traffic.

- [ ] **Step 5: Treat initial static build as preflight only and verify root plus deep links.** Blueprint resource creation may build current `main`; do not create promotion metadata or begin 48-hour bake. Task 5 performs canonical exact-SHA deployment.

```bash
render deploys create "$RENDER_STAGING_STATIC_DASHBOARD_ID" --commit "$DEPLOY_SHA" --wait --confirm -o text
curl --fail "$STAGING_STATIC_DASHBOARD_URL/"
curl --fail "$STAGING_STATIC_DASHBOARD_URL/cycles"
curl --fail "$STAGING_STATIC_DASHBOARD_URL/settings"
```

Expected: every path returns SPA `index.html`; hashed assets use immutable cache header.

### Task 3: Normalize recommender internal address

**Files:**

- Modify: `artifacts/api-server/src/routes/recommend.ts:67-95`
- Modify: `artifacts/api-server/src/tests/routes/recommend.test.ts`

**Interfaces:**

```ts
export function normalizeServiceUrl(value: string): URL;
```

Accept `https://public-service.onrender.com` and Render `host:port`; prepend `http://` only when scheme is absent.

- [ ] **Step 1: Write failing tests** for HTTPS URL, `host:port`, trailing slash, invalid/blank values, and preservation of private port.

- [ ] **Step 2: Implement normalizer** and build endpoint with `new URL("/recommend", base)` rather than string concatenation.

- [ ] **Step 3: Run focused test.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/recommend.test.ts
```

- [ ] **Step 4: Commit.**

```bash
git add artifacts/api-server/src/routes/recommend.ts artifacts/api-server/src/tests/routes/recommend.test.ts
git commit -m "fix(api): accept Render private service addresses"
```

### Task 4: Add blue-green private recommender resources

**Files:**

- Modify: `render.yaml:88-113`
- Modify: `docs/runbooks/staging-and-production-deploy.md`

**Interfaces:**

- Produces `farmsmart-recommender-private-staging` and `farmsmart-recommender-private`; API receives `hostport` through `fromService`.

- [ ] **Step 1: Add staging private service.**

```yaml
- type: pserv
  name: farmsmart-recommender-private-staging
  runtime: python
  plan: starter
  region: oregon
  autoDeployTrigger: off
  buildCommand: cd artifacts/recommender-svc && pip install uv && uv sync --locked
  startCommand: cd artifacts/recommender-svc && uv run uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Copy staging-only database/provider/internal-key secrets. Do not add public domains. Do not rely on `healthCheckPath` for private service; verify from API/private network.

- [ ] **Step 2: Add equivalent production private service.** Keep public recommender unchanged.

- [ ] **Step 3: Wire staging API.**

```yaml
- key: RECOMMENDER_URL
  fromService:
    type: pserv
    name: farmsmart-recommender-private-staging
    property: hostport
```

- [ ] **Step 4: Validate, commit, and push declaration.**

```bash
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
git add render.yaml docs/runbooks/staging-and-production-deploy.md
git commit -m "infra(recommender): declare private service topology"
```

Stop for human approval. Push only when explicitly authorized; Blueprint sync follows authorized push.

- [ ] **Step 5: Sync Blueprint and discover IDs.** Store staging/production private service IDs in protected GitHub environments. Do not route production API to new service.

- [ ] **Step 6: Perform non-promotable private-network preflight.** Deploy private recommender then API only to verify staging API connectivity; configuration-triggered/manual deploys here never create promotion evidence.

```bash
render deploys create "$RENDER_STAGING_PRIVATE_RECOMMENDER_ID" --commit "$DEPLOY_SHA" --wait --confirm -o text
render deploys create "$RENDER_STAGING_API_SERVICE_ID" --commit "$DEPLOY_SHA" --wait --confirm -o text
```

- [ ] **Step 7: Verify authenticated recommendation through API.** Confirm no public `onrender.com` URL exists. Task 5 repeats this through canonical workflow and records exact-SHA evidence.

### Task 5: Add monorepo deploy selection and cut workflow topology

**Files:**

- Modify: `render.yaml`
- Create: `scripts/ci/render-service-selection.mjs`
- Create: `scripts/ci/render-service-selection.test.mjs`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `docs/runbooks/staging-and-production-deploy.md`

**Interfaces:**

- `buildFilter` documents dependencies for previews/future auto-deploys.
- Selector maps Git diff to logical `api`, `dashboard`, and `recommender` services.
- Staging deploys selected services and writes schema-v2 topology evidence; production deploys exactly selection verified by staging.

- [ ] **Step 1: Add API filter.**

```yaml
buildFilter:
  paths:
    - artifacts/api-server/**
    - lib/api-spec/**
    - lib/api-zod/**
    - lib/db/**
    - lib/metrics/**
    - package.json
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
    - tsconfig.base.json
```

- [ ] **Step 2: Add dashboard filter.** Include `artifacts/admin-dashboard/**`, `attached_assets/**`, `lib/api-spec/**`, `lib/api-client-react/**`, `lib/metrics/**`, and root package/workspace/TypeScript files.

- [ ] **Step 3: Add recommender filter.** Include `artifacts/recommender-svc/**`; include root files only if its build actually consumes them.

- [ ] **Step 4: Implement changed-path selector.** Use same dependency sets as build filters. Known documentation-only paths select none; any unknown non-documentation path selects all. Force all for `render.yaml`, selector itself, or either deploy workflow. Tests cover shared DB, metrics, API spec, lockfile, dashboard-only, recommender-only, docs-only, workflow-control, and unknown paths.

- [ ] **Step 5: Resolve staging baseline safely.** Download latest prior successful staging metadata. Use prior `tested_sha` only after proving it is ancestor of `DEPLOY_SHA`; no prior artifact selects all. Malformed/non-ancestor evidence fails. Foundation schema-v1 may provide baseline SHA but cannot be promoted after this cut. Topology mismatch selects all with reason `topology_change`. Compute NUL-delimited paths with `git diff --name-only -z "$BASE_SHA" "$DEPLOY_SHA"`.

- [ ] **Step 6: Switch staging workflow topology before canonical deploy.** Map `api` to staging API, `dashboard` to staging static dashboard, and `recommender` to staging private recommender. Deploy selected services in recommender/API/dashboard order. Always apply migrations and run full-system smoke tests including private recommendation and static deep links.

- [ ] **Step 7: Emit schema-v2 staging evidence.** Metadata contains `schema_version: 2`, topology `release-3-static-private-v1`, tested/base SHAs, selection reason, changed paths, selected/skipped logical services, staging workflow ID, selected service deploy IDs/commits/status, and active snapshot of all three logical services. Selected deploys must be `live` at tested SHA; sets must be disjoint/exhaustive. Never include credentials. Upload immutable `staging-deploy-$DEPLOY_SHA` for 30 days.

- [ ] **Step 8: Update production workflow before canonical staging run.** Map logical services to production API/static/private IDs. Download metadata from exact triggering staging run; require schema/topology, matching workflow ID, SHA ancestry, allowlisted exhaustive sets, protected staging IDs, and selected staging deploys live at SHA. Use `selected_services` verbatim, deploy in recommender/API/dashboard order, and retain production deploy/active-commit evidence. Never rerun selector in production.

- [ ] **Step 9: Validate.**

```bash
node --test scripts/ci/render-service-selection.test.mjs
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

- [ ] **Step 10: Commit topology and workflow control together.**

```bash
git add render.yaml scripts/ci/render-service-selection.mjs scripts/ci/render-service-selection.test.mjs .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml docs/runbooks/staging-and-production-deploy.md
git commit -m "perf(deploy): scope Render monorepo rebuilds"
```

- [ ] **Step 11: Stop for human approval.** After authorized push, sync Blueprint, update protected staging/production service-ID variables, and run canonical staging workflow. Topology change forces all three resources. Verify schema-v2 evidence before beginning 48-hour bake.

### Task 6: Cut production traffic over with blue-green rollback

**Files:**

- Modify: `DEPLOY.md`
- Modify: `docs/runbooks/staging-and-production-deploy.md`

**Consumes:** Tasks 1-5 deployed and baked in staging for 48 hours.

- [ ] **Step 1: Freeze promotion inputs.** Identify successful canonical staging workflow/artifact, `tested_sha`, topology, and pending protected production run. Do not change workflows or selector after this staging run.

```bash
git add DEPLOY.md docs/runbooks/staging-and-production-deploy.md
git commit -m "docs(deploy): prepare blue-green Render cutover"
```

- [ ] **Step 2: Record rollback state.** Save custom domain target, API CORS origins, public recommender URL, old service IDs, active deploy IDs, and last-good SHAs.

- [ ] **Step 3: Approve exact production promotion.** Approve only workflow triggered by chosen canonical staging run. It deploys metadata-selected resources at `tested_sha`; do not move traffic yet.

- [ ] **Step 4: Smoke new resources.** Test dashboard deep links, auth, API calls, recommendation path, and mobile compatibility.

- [ ] **Step 5: Repoint API to private recommender and redeploy API.** Verify recommendations and record configuration-triggered deploy ID before dashboard cutover.

- [ ] **Step 6: Move dashboard custom domain to static site and update API `CORS_ORIGINS`.** Verify OAuth redirect allowlist before traffic and record resulting API deploy ID.

- [ ] **Step 7: Monitor 48 hours.** Compare API error rate, recommender latency, dashboard asset errors, and Render spend/pipeline minutes.

- [ ] **Step 8: Keep old resources seven days.** Disable user traffic but preserve rollback. Delete old Node dashboard/public recommender only after rollback drill and approval.

- [ ] **Step 9: Record post-cutover evidence in a separate documentation commit.**

```bash
git add DEPLOY.md docs/runbooks/staging-and-production-deploy.md
git commit -m "docs(deploy): record Render cutover evidence"
```

## Release 3 Verification Gate

```bash
NODE_ENV=production BASE_PATH=/ pnpm --filter @workspace/admin-dashboard run build
pnpm run typecheck
pnpm --filter @workspace/api-server run test
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
node --test scripts/ci/render-service-selection.test.mjs
```

Required evidence:

- Static dashboard deep links and assets work through CDN.
- Private recommender has no public URL and is reachable through API.
- Representative changed paths select expected logical services; production consumes staging selection without recomputation.
- Staging metadata is schema 2 with `release-3-static-private-v1`; selected deploys are live at `tested_sha` and skipped active commits are recorded.
- Exact staging-tested SHA is deployed to production.
- Old resources remain available for rollback window.

## Rollback

- Recommender: repoint API `RECOMMENDER_URL` to old public service, redeploy API last-good SHA, then investigate private service.
- Dashboard: move custom domain back to old Node service and restore old CORS origin.
- Selector miss: stop promotion, add path to selector and matching build filter, test, and rerun staging; never compensate with manual production deploy.
- Baseline/metadata failure: malformed or non-ancestor evidence fails closed. Force all only for first run or topology change.
- Topology rollback: restore old logical service-ID mapping in both workflows through corrective commit, rerun canonical staging, then promote only new matching evidence.
- Never attempt in-place type/runtime reversal; rollback uses retained blue-green resources.
