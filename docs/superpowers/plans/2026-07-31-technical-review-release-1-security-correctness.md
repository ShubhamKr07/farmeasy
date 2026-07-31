# Technical Review Release 1: Security And Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close active privilege escalation and data-exposure paths, restore broken API behavior, bound expensive requests, validate database TLS, and migrate uploaded media to private access.

**Architecture:** Supabase Auth inserts profiles through a locked-down trigger. Shipped mobile clients remain compatible until adoption allows direct Data API permissions to be removed. Express validates all operational requests and signs private media references at response time. Liveness remains process-only; readiness checks PostgreSQL separately.

**Tech Stack:** Supabase Auth/Postgres/Storage, Express 5, Drizzle, Zod, Expo, FastAPI/Pydantic, node:test, Supertest, pytest.

## Global Constraints

- Complete `2026-07-31-technical-review-foundation-ci-staging.md` first.
- Never use `raw_user_meta_data` for authorization.
- Drop the unsafe profile UPDATE policy immediately; do not wait for mobile adoption.
- Keep old mobile sign-up compatible until adoption gate because installed clients still call `public.users.insert`.
- Preserve `/api/healthz` as liveness for mobile polling; add `/api/readyz` for Render readiness.
- Private media rollout is expand/contract: compatibility API first, key backfill second, bucket privacy last.
- Use forward-only migrations and Supabase Security Advisor after every Auth/RLS/Storage migration.

---

### Task 1: Stop role escalation and install profile trigger

**Files:**

- Create: `supabase/migrations/00004_create_auth_profiles.sql`
- Create: `supabase/tests/00004_auth_profiles.test.sql`
- Create: `scripts/verify-auth-profiles.sql`

**Interfaces:**

- Consumes `public.users` and `public.user_role` from Drizzle.
- Produces `private.handle_new_user()` and `on_auth_user_created`; removes direct profile UPDATE policy while retaining temporary pre-verification INSERT compatibility for installed mobile builds.

- [ ] **Step 1: Audit production/staging before migration.**

```sql
select role, count(*) from public.users group by role order by role;

select au.id, au.email
from auth.users au
left join public.users pu on pu.id = au.id
where pu.id is null;

select pu.id, pu.email
from public.users pu
left join auth.users au on au.id = pu.id
where au.id is null;
```

Expected: every non-technician role has an identified owner; orphan lists are reviewed before adding FK.

- [ ] **Step 2: Write failing pgTAP tests.** Assert:
  - New `auth.users` row gets one `public.users` row with `technician` role.
  - Client-supplied `raw_user_meta_data.role = facility_lead` is ignored.
  - Authenticated self-update cannot modify role.
  - Existing non-technician roles are preserved by backfill.

- [ ] **Step 3: Create migration in race-safe order.**

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, role)
  values (new.id, new.email, 'technician'::public.user_role)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

insert into public.users (id, email, role)
select id, email, 'technician'::public.user_role
from auth.users
on conflict (id) do nothing;

drop policy if exists "users can update their own row (not role)" on public.users;

alter table public.users
  add constraint users_id_auth_users_id_fk
  foreign key (id) references auth.users(id) on delete cascade;
```

- [ ] **Step 4: Add duplicate-only legacy compatibility policy.** Installed clients retry `public.users.insert` after Auth signup and accept SQLSTATE `23505`. Permit retry only when trigger-created profile already exists; anonymous callers must never repair or create a missing profile.

```sql
create or replace function private.profile_already_exists(candidate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users
    where id = candidate_id
  );
$$;

revoke all on function private.profile_already_exists(uuid) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.profile_already_exists(uuid) to anon, authenticated;

drop policy if exists "users can insert their own row" on public.users;
create policy "temporary legacy signup duplicate"
on public.users for insert
to anon, authenticated
with check (
  role = 'technician'::public.user_role
  and private.profile_already_exists(id)
);
```

Trigger runs before `signUp` returns, so legitimate retry reaches duplicate-key handling. pgTAP must prove existing trigger-created profile retry as `anon` returns `23505`; deleting profile for a real Auth identity then retrying yields RLS denial and no row; random UUID/elevated role attempts fail; trigger still creates exactly one profile. Task 3 removes helper and grants after adoption gate.

- [ ] **Step 5: Test migration locally through disposable Supabase replay.**

```bash
bash scripts/ci/test-disposable-supabase.sh
```

- [ ] **Step 6: Commit before persistent staging migration.**

```bash
git add supabase/migrations/00004_create_auth_profiles.sql supabase/tests/00004_auth_profiles.test.sql scripts/verify-auth-profiles.sql
git commit -m "fix(auth): prevent role escalation and provision profiles"
```

- [ ] **Step 7: Stop for human approval.** After authorized push, exact-SHA staging workflow applies migration. Then verify and run advisors.

```bash
pnpm exec supabase test db --db-url "$STAGING_DATABASE_URL_DIRECT" supabase/tests/00004_auth_profiles.test.sql
psql "$STAGING_DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f scripts/verify-auth-profiles.sql
pnpm exec supabase db advisors --db-url "$STAGING_DATABASE_URL_DIRECT" --fail-on error
```

### Task 2: Remove client profile writes and read JWT role correctly

**Files:**

- Modify: `artifacts/farmeasy/app/(auth)/sign-up.tsx:33-69`
- Modify: `artifacts/farmeasy/hooks/useUserRole.ts`
- Create: `artifacts/farmeasy/hooks/useUserRole.test.ts`
- Modify: `lib/api-client-react/src/custom-fetch.ts`
- Modify: `artifacts/farmeasy/app/_layout.tsx`
- Modify: `artifacts/api-server/src/app.ts`
- Create: `scripts/ci/test-supabase-signup.mjs`
- Create: `scripts/ci/report-mobile-version-adoption.mjs`
- Create: `docs/security/mobile-version-adoption.md`
- Delete: `tests/e2e/farmeasy.spec.ts`
- Delete: `tests/playwright.config.ts`
- Delete: `tests/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/deploy-staging.yml`

**Interfaces:**

- Consumes profile trigger from Task 1 and staging OTP mailbox from foundation plan.
- Produces sign-up that only calls Supabase Auth and role retrieval through `supabase.auth.getClaims()`.

- [ ] **Step 1: Write failing role tests.** Assert custom `user_role` claim is returned and absent claim defaults to `technician`.

- [ ] **Step 2: Replace role lookup.**

```ts
export async function getUserRole(): Promise<UserRole> {
  const { data, error } = await supabase.auth.getClaims();
  if (error) throw error;
  return (data?.claims.user_role as UserRole | undefined) ?? "technician";
}
```

- [ ] **Step 3: Remove sign-up metadata and profile insert.** Keep `supabase.auth.signUp({ email, password })`, OTP verification, resend, and existing UI states.

- [ ] **Step 4: Add client-version telemetry.** Add `setClientVersion(version: string | null)` to shared custom fetch, set `X-FarmSmart-Client-Version` on mobile API requests, initialize it from Expo application/config version, and include bounded version field in API request logs.

- [ ] **Step 5: Remove obsolete Clerk/Replit Playwright package and replace it with hosted Auth integration.** Delete suite containing hard-coded Clerk credentials and Replit-only URL, remove `tests` workspace package and Playwright dependencies, and delete Clerk test identity because committed password is compromised. Hosted script generates unique email, signs up through staging anon client, retrieves/verifies OTP, asserts exactly one trigger-created technician profile and metadata cannot select role, refreshes claims, signs out/in, then deletes identity/profile in `finally`. Run script in staging workflow after exact-SHA services are live and before promotion metadata upload. Record manual native UI smoke as physical-runtime exception; automate all non-hardware Auth behavior.

- [ ] **Step 6: Run tests.**

```bash
pnpm --filter @workspace/farmeasy run test
pnpm --filter @workspace/farmeasy run typecheck
STAGING_SUPABASE_URL="$STAGING_SUPABASE_URL" \
STAGING_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
STAGING_SUPABASE_SERVICE_ROLE_KEY="$STAGING_SUPABASE_SERVICE_ROLE_KEY" \
STAGING_TEST_EMAIL_DOMAIN="$STAGING_TEST_EMAIL_DOMAIN" \
STAGING_MAILBOX_API_TOKEN="$STAGING_MAILBOX_API_TOKEN" \
STAGING_TEST_PASSWORD="$STAGING_TEST_PASSWORD" node scripts/ci/test-supabase-signup.mjs
```

- [ ] **Step 7: Add executable adoption report.** Script accepts App Store/Play Console version CSV exports plus Render mobile-version NDJSON export, calculates weighted supported share, and exits nonzero below `0.99` or when unsupported API requests occur in final 72 hours.

```bash
set -o pipefail
node scripts/ci/report-mobile-version-adoption.mjs \
  --ios /secure/app-store-versions.csv \
  --android /secure/play-console-versions.csv \
  --api /secure/render-mobile-version-logs.ndjson \
  --minimum-version "$MIN_SUPPORTED_MOBILE_VERSION" \
  --threshold 0.99 | tee docs/security/mobile-version-adoption.md
```

- [ ] **Step 8: Bake and measure adoption.** Complete ten staging sign-ups and verify no missing profile. Promote mobile update through EAS. Do not begin Task 3 until report passes for seven-day window and no unsupported request appears for 72 hours.

- [ ] **Step 9: Commit.**

```bash
git add "artifacts/farmeasy/app/(auth)/sign-up.tsx" artifacts/farmeasy/hooks/useUserRole.ts artifacts/farmeasy/hooks/useUserRole.test.ts artifacts/farmeasy/app/_layout.tsx lib/api-client-react/src/custom-fetch.ts artifacts/api-server/src/app.ts scripts/ci/test-supabase-signup.mjs scripts/ci/report-mobile-version-adoption.mjs docs/security/mobile-version-adoption.md pnpm-workspace.yaml pnpm-lock.yaml .github/workflows/deploy-staging.yml tests
git commit -m "fix(farmeasy): rely on auth profile trigger"
```

### Task 3: Deny direct Data API access

**Files:**

- Create: `supabase/migrations/00005_lock_down_public_data.sql`
- Create: `supabase/tests/00005_public_rls.test.sql`
- Create: `scripts/verify-public-rls.sql`

**Interfaces:**

- Consumes Task 2 mobile adoption evidence.
- Produces RLS enabled on all 26 application tables and no direct `anon`/`authenticated` operational access.

- [ ] **Step 1: Enumerate exact tables in tests.** Include `users`, `crops`, `growth_profiles`, `seed_lots`, `cycles`, `manual_checks`, `alerts`, `inventory_items`, `shipments`, `facilities`, `rooms`, `channels`, `racks`, `trays`, `sensor_status`, `sensors`, `sensor_readings`, `cycle_seed_lots`, `tasks`, `bad_tray_entries`, `stock_movements`, `user_settings`, `accounting_connections`, `recommender_cache`, `recommender_queries`, and `facility_logs`.

- [ ] **Step 2: Write pgTAP tests** for `relrowsecurity`, table grants, policies, and authenticated JWT read/write denial. Do not treat a successful empty `SELECT` with null `auth.uid()` as sufficient proof.

- [ ] **Step 3: Create migration.** Enable RLS, drop `temporary legacy signup duplicate` and remaining profile policies, drop `private.profile_already_exists(uuid)`, revoke temporary `private` schema usage from `anon`/`authenticated`, revoke direct table privileges, and preserve `supabase_auth_admin` access required by custom access-token hook.

- [ ] **Step 4: Verify API database role before promotion.**

```sql
select current_user, rolbypassrls
from pg_roles
where rolname = current_user;
```

- [ ] **Step 5: Test locally, then commit before persistent staging migration.**

```bash
bash scripts/ci/test-disposable-supabase.sh
git add supabase/migrations/00005_lock_down_public_data.sql supabase/tests/00005_public_rls.test.sql scripts/verify-public-rls.sql
git commit -m "fix(db): deny direct operational data access"
```

- [ ] **Step 6: Stop for human approval.** After authorized push, exact-SHA staging workflow applies migration. Then verify staging.

```bash
pnpm exec supabase test db --db-url "$STAGING_DATABASE_URL_DIRECT" supabase/tests/00005_public_rls.test.sql
psql "$STAGING_DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f scripts/verify-public-rls.sql
curl --fail --silent --show-error "$STAGING_API_URL/api/readyz"
```

### Task 4: Add reusable authenticated API route test harness

**Files:**

- Modify: `artifacts/api-server/package.json:33-44`
- Modify: `pnpm-lock.yaml`
- Create: `artifacts/api-server/src/tests/helpers/testApp.ts`
- Create: `artifacts/api-server/src/tests/helpers/testDatabase.ts`

**Produces:** `createAuthenticatedTestApp(router, user?)` and serial database fixture helpers used by Tasks 5-9 and Release 2.

- [ ] **Step 1: Install test-only HTTP dependency.**

```bash
pnpm --filter @workspace/api-server add -D supertest @types/supertest
```

- [ ] **Step 2: Create authenticated app helper.** Mount JSON middleware, set `req.supabaseUser`, and mount provided router under `/api`; never bypass auth in production app.

```ts
export function createAuthenticatedTestApp(
  router: Router,
  user = {
    sub: "00000000-0000-4000-8000-000000000001",
    user_role: "technician",
  },
): Express;
```

- [ ] **Step 3: Create DB fixture helper** that requires `TEST_DATABASE_URL`, truncates only named tables, and closes pool after suite.

- [ ] **Step 4: Add smoke test and run.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server run test
```

- [ ] **Step 5: Commit.**

```bash
git add artifacts/api-server/package.json artifacts/api-server/src/tests/helpers pnpm-lock.yaml
git commit -m "test(api): add authenticated route harness"
```

### Task 5: Repair recommender user identity and audit logging

**Files:**

- Modify: `artifacts/recommender-svc/app/models.py:1-11`
- Modify: `artifacts/recommender-svc/app/main.py:34-95`
- Modify: `artifacts/recommender-svc/app/query_log.py:15-35`
- Modify: `artifacts/api-server/src/routes/recommend.ts:82-90`
- Create: `artifacts/recommender-svc/tests/test_query_log.py`
- Modify: `lib/api-spec/openapi.yaml` if recommender proxy schema exposes legacy name

- [ ] **Step 1: Write failing Python test.** Assert generated SQL contains `user_id`, never `clerk_user_id`.

- [ ] **Step 2: Rename request contract.**

```python
class RecommendRequest(BaseModel):
    user_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    ops_context: str | None = None
```

- [ ] **Step 3: Rename `log_query` parameter and SQL column.** Update every call in `main.py`.

- [ ] **Step 4: Change Express payload.**

```ts
body: JSON.stringify({
  user_id: userId,
  question: question.trim(),
  ops_context: opsContext,
});
```

- [ ] **Step 5: Run focused and full tests.**

```bash
uv run --directory artifacts/recommender-svc pytest tests/test_query_log.py -v
uv run --directory artifacts/recommender-svc pytest -v
pnpm --filter @workspace/api-server run typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add artifacts/recommender-svc/app artifacts/recommender-svc/tests/test_query_log.py artifacts/api-server/src/routes/recommend.ts lib/api-spec/openapi.yaml
git commit -m "fix(recommender): use migrated user identity"
```

### Task 6: Fix task listing semantics

**Files:**

- Modify: `artifacts/api-server/src/routes/tasks.ts:22-39`
- Create: `artifacts/api-server/src/tests/routes/tasks.test.ts`

- [ ] **Step 1: Seed one pending and one completed task; write failing tests for default and `status=done`.**
- [ ] **Step 2: Build one condition:** explicit valid status returns `eq(status)`; absent/invalid status returns `isNull(completedAt)`.
- [ ] **Step 3: Run test.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/tasks.test.ts
```

- [ ] **Step 4: Commit.**

```bash
git add artifacts/api-server/src/routes/tasks.ts artifacts/api-server/src/tests/routes/tasks.test.ts
git commit -m "fix(tasks): return completed status results"
```

### Task 7: Fix filtered shipment keyset pagination

**Files:**

- Modify: `artifacts/api-server/src/routes/shipments.ts:29-70`
- Create: `artifacts/api-server/src/tests/routes/shipments.test.ts`

- [ ] **Step 1: Seed more than one page where matches appear after non-matches; write failing status/client page tests.**
- [ ] **Step 2: Parse and validate query into:**

```ts
type ShipmentListQuery = {
  cursor?: number;
  limit: number;
  status?: "pending" | "in_progress" | "complete";
  client?: string;
};
```

- [ ] **Step 3: Add cursor, status, and escaped literal client substring conditions to SQL before `limit + 1`.**
- [ ] **Step 4: Run focused test and commit.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/shipments.test.ts
git add artifacts/api-server/src/routes/shipments.ts artifacts/api-server/src/tests/routes/shipments.test.ts
git commit -m "fix(shipments): filter before keyset pagination"
```

### Task 8: Validate inventory mutations

**Files:**

- Modify: `artifacts/api-server/src/routes/inventory.ts:59-109`
- Create: `artifacts/api-server/src/tests/routes/inventory.test.ts`

- [ ] **Step 1: Write failing create, partial-update, and concurrency tests.** Cover blank name, non-number, infinity, negative values, invalid arrival date, create `currentQty > maxQty`, PATCH only `currentQty` above stored `maxQty`, PATCH only `maxQty` below stored `currentQty`, empty PATCH, and two concurrent individually valid patches whose combined values would violate constraint.
- [ ] **Step 2: Validate PATCH against atomically merged state.** Parse scalar fields with strict partial Zod schema. In one transaction, select item `FOR UPDATE`, return 404 if absent, merge supplied fields with locked row, validate complete cross-field state, then update before releasing lock. Never read outside transaction. Concurrency test sets `currentQty=9` and `maxQty=8`; at most one succeeds and final row satisfies `currentQty <= maxQty`.
- [ ] **Step 3: Run focused test and commit.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/inventory.test.ts
git add artifacts/api-server/src/routes/inventory.ts artifacts/api-server/src/tests/routes/inventory.test.ts
git commit -m "fix(inventory): validate mutation payloads"
```

### Task 9: Bound recommendation requests and CORS

**Files:**

- Modify: `artifacts/api-server/src/app.ts:25-50`
- Modify: `artifacts/api-server/src/routes/recommend.ts:58-96`
- Modify: `artifacts/api-server/src/routes/accounting.ts`
- Create: `artifacts/api-server/src/tests/routes/recommend.test.ts`
- Create: `artifacts/api-server/src/tests/routes/accounting.test.ts`
- Modify: `artifacts/recommender-svc/app/config.py`
- Modify: `artifacts/recommender-svc/app/main.py`
- Modify: `artifacts/recommender-svc/app/embeddings.py`
- Modify: `artifacts/recommender-svc/app/synthesis.py`
- Modify: `artifacts/recommender-svc/app/ingest.py`
- Create: `artifacts/recommender-svc/tests/test_request_limits.py`
- Modify: `render.yaml`

- [ ] **Step 1: Write failing tests for missing production origin config, untrusted origin, trusted proxy parsing, spoofed `X-Forwarded-For`, per-user exhaustion, per-IP exhaustion across users, 2,001-character question, and upstream timeout.**
- [ ] **Step 2: Parse `CORS_ORIGINS` as comma-separated exact browser origins; fail startup in production when empty.** Requests without `Origin` remain valid for native mobile and server clients.
- [ ] **Step 3: Add dedicated `DASHBOARD_URL`.** Update QuickBooks callback redirect logic in `routes/accounting.ts` to stop deriving destination from legacy `CORS_ORIGIN`; add staging/production Blueprint values and tests.
- [ ] **Step 4: Reduce global JSON body limit to `1mb`; keep multer's route-specific 5 MiB limit.**
- [ ] **Step 5: Add independent recommendation limits.** Require positive integer `TRUST_PROXY_HOPS` in production, set Express `trust proxy` to it, and configure staging/production API as `1`. Apply 20 requests per 15 minutes by `getAuth(req).userId` and separate 60 requests per 15 minutes by `ipKeyGenerator(req.ip)`. Never use composite key. Tests prove attacker-supplied left-most forwarded values do not alter client IP and multiple users sharing one IP hit IP budget. Keep process-local stores and prohibit horizontal API scaling until shared store exists.
- [ ] **Step 6: Validate and trim question before dashboard work; use `AbortSignal.timeout(10_000)`.**
- [ ] **Step 7: Bound work inside recommender service.** Configure `RECOMMENDER_REQUEST_DEADLINE_SECONDS=9`, bounded queue timeout, max concurrency, Gemini timeout, and Tavily timeout. Acquire process-wide semaphore with queue timeout and return 503 on saturation; wrap complete processing in `asyncio.timeout`, return 504 on expiry, and always release capacity. Configure Google GenAI HTTP timeout. Replace dlt-managed Tavily fetch with existing `httpx` using finite connect/read/write/pool timeouts, then pass rows to existing dlt load. Tests assert deadline cancellation, saturation, max active count, provider timeout configuration, and release on exception/timeout/cancellation.
- [ ] **Step 8: Run tests and Blueprint validation.**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/recommend.test.ts src/tests/routes/accounting.test.ts
uv run --directory artifacts/recommender-svc pytest tests/test_request_limits.py -v
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

- [ ] **Step 9: Commit.**

```bash
git add artifacts/api-server/src/app.ts artifacts/api-server/src/routes/recommend.ts artifacts/api-server/src/routes/accounting.ts artifacts/api-server/src/tests/routes/recommend.test.ts artifacts/api-server/src/tests/routes/accounting.test.ts artifacts/recommender-svc/app artifacts/recommender-svc/tests/test_request_limits.py render.yaml
git commit -m "fix(api): bound origins and recommendation cost"
```

### Task 10: Validate TLS and split liveness from readiness

**Files:**

- Create: `lib/db/src/ssl.ts`
- Modify: `lib/db/src/index.ts:7-16`
- Modify: `lib/db/scripts/migrate.mjs:11-22`
- Modify: `artifacts/recommender-svc/app/config.py`
- Modify: `artifacts/recommender-svc/app/db.py`
- Modify: `artifacts/recommender-svc/app/ingest.py`
- Create: `artifacts/recommender-svc/app/tls.py`
- Modify: `artifacts/api-server/src/routes/health.ts:1-11`
- Create: `artifacts/api-server/src/tests/routes/health.test.ts`
- Modify: `render.yaml`

- [ ] **Step 1: Write tests for missing production CA, invalid CA, `/healthz` without DB, and `/readyz` returning 503 when `select 1` exceeds 2 seconds.**
- [ ] **Step 2: Add `DATABASE_CA_CERT` to API, migration, and recommender clients.** Node uses `{ ca, rejectUnauthorized: true }`; Python `tls.py` builds `ssl.create_default_context(cadata=...)`, writes certificate to `/tmp/farmsmart-db-ca.pem` with mode `0600` for psycopg2/dlt, and removes file during lifespan shutdown. Asyncpg sets `statement_cache_size=0`; dlt direct connection uses `sslmode=verify-full&sslrootcert=/tmp/farmsmart-db-ca.pem`. Add tests proving insecure fallback is absent and file permissions/cleanup work.
- [ ] **Step 3: Keep `/api/healthz` process-only and add `/api/readyz`.** Configure Render API health check to `/api/readyz`; mobile remains on `/api/healthz`.
- [ ] **Step 4: Add `DATABASE_CA_CERT` as `sync: false` for API and recommender staging/production services.** Verify direct migration URL uses `sslmode=verify-full` or equivalent CA configuration.
- [ ] **Step 5: Run tests and staging probes.**

```bash
pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/health.test.ts
pnpm run typecheck
uv run --directory artifacts/recommender-svc pytest -v
curl --fail "$STAGING_API_URL/api/healthz"
curl --fail "$STAGING_API_URL/api/readyz"
```

- [ ] **Step 6: Commit.**

```bash
git add lib/db/src/ssl.ts lib/db/src/index.ts lib/db/scripts/migrate.mjs artifacts/recommender-svc/app/config.py artifacts/recommender-svc/app/db.py artifacts/recommender-svc/app/ingest.py artifacts/recommender-svc/app/tls.py artifacts/api-server/src/routes/health.ts artifacts/api-server/src/tests/routes/health.test.ts render.yaml
git commit -m "fix(db): validate TLS and expose readiness"
```

### Task 11: Deploy media key compatibility API

**Files:**

- Create: `artifacts/api-server/src/services/mediaUrls.ts`
- Modify: `artifacts/api-server/src/routes/media.ts:32-51`
- Modify: `artifacts/api-server/src/routes/cycles.ts`
- Modify: `artifacts/api-server/src/routes/facilityLogs.ts`
- Modify: `artifacts/farmeasy/utils/uploadPhoto.ts`
- Modify: `lib/api-spec/openapi.yaml`
- Regenerate: `lib/api-client-react/src/generated/`, `lib/api-zod/src/generated/`
- Create: `artifacts/api-server/src/tests/services/mediaUrls.test.ts`

**Produces:** Upload response `{ key, url: key }`; stored object keys are signed for one hour at API response boundary.

- [ ] **Step 1: Write signing tests.** Preserve external URLs, sign bucket-relative keys, preserve order, and fail response when signing fails. Current object keys are filename-only, not `media/<key>`.
- [ ] **Step 2: Implement service.**

```ts
export async function signMediaReferences(
  references: readonly string[],
  expiresInSeconds = 3600,
): Promise<string[]>;
```

- [ ] **Step 3: Return compatibility upload response.** Old clients read `url`; new clients prefer `key`; both values contain the same bucket-relative key.
- [ ] **Step 4: Sign references returned from manual checks, bad-tray entries, and `facility_logs.data.photoUrls`.** Do not invent a `facility_logs.photo_urls` column.
- [ ] **Step 5: Update OpenAPI and regenerate clients.**

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
```

- [ ] **Step 6: Commit compatibility API before deployment.**

```bash
git add artifacts/api-server/src/services/mediaUrls.ts artifacts/api-server/src/routes artifacts/farmeasy/utils/uploadPhoto.ts lib/api-spec/openapi.yaml lib/api-client-react/src/generated lib/api-zod/src/generated artifacts/api-server/src/tests/services/mediaUrls.test.ts
git commit -m "feat(media): store keys and sign response URLs"
```

- [ ] **Step 7: Stop for human approval.** After authorized push, deploy through staging workflow while bucket is still public. Verify new uploads persist keys and old public URLs remain readable during compatibility window.
- [ ] **Step 8: Promote compatibility API to production while bucket remains public.** Use Foundation protected exact-SHA production workflow. Verify new production uploads persist keys, API responses contain signed URLs, and legacy public URLs remain readable. Do not begin Task 12 until every production API replica runs this SHA and evidence is recorded.

### Task 12: Backfill references and make media bucket private

**Files:**

- Create: `supabase/migrations/00006_private_media.sql`
- Create: `supabase/tests/00006_private_media.test.sql`
- Create: `scripts/verify-private-media.sql`
- Create: `scripts/ci/probe-private-media.mjs`
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `docs/runbooks/staging-bootstrap.md`

**Consumes:** Task 11 compatibility API deployed and verified on every staging and production API replica while both buckets remain public.

- [ ] **Step 1: Write migration tests** for ordered conversion in `manual_checks.photo_urls`, `bad_tray_entries.photo_urls`, and JSON array `facility_logs.data->'photoUrls'`; preserve external URLs.
- [ ] **Step 2: Backfill only exact project prefixes recorded by ADR-004:** production project and staging project. Replace staging reference with its literal value when authoring migration; committed migration files contain no angle-bracket token. Convert only when extracted key exists in current project's `storage.objects` `media` bucket.

```text
https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/
```

Use `WITH ORDINALITY` when reconstructing arrays.

- [ ] **Step 3: Assert zero Supabase public-media URLs remain across all three stores, regardless of host.** Abort migration before bucket flip if count is nonzero.

- [ ] **Step 4: Make bucket private.**

```sql
update storage.buckets set public = false where id = 'media';
```

- [ ] **Step 5: Run migration tests against disposable Supabase before commit.**

```bash
bash scripts/ci/test-disposable-supabase.sh
```

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/00006_private_media.sql supabase/tests/00006_private_media.test.sql scripts/verify-private-media.sql scripts/ci/probe-private-media.mjs .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml docs/runbooks/staging-bootstrap.md
git commit -m "fix(storage): make uploaded media private"
```

- [ ] **Step 7: Stop for human approval.** After authorized push, staging workflow applies `00006_private_media.sql` with `supabase db push`.

- [ ] **Step 8: Verify staging after migration.** Public object URL must fail; signed API URL must return 200 before expiry.

```bash
psql "$STAGING_DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f scripts/verify-private-media.sql
curl --fail "$SIGNED_MEDIA_URL"
if curl --fail "$PUBLIC_MEDIA_URL"; then exit 1; fi
```

- [ ] **Step 9: Run automated staging probe.** Temporary authenticated user uploads small image through API, persists key through supported facility-log API, fetches API-returned signed URL requiring 200, constructs exact public Storage URL requiring non-2xx, then deletes log/object/profile/Auth identity in `finally`. Never log or artifact signed URL.
- [ ] **Step 10: Stop for protected production approval.** Promote only through Foundation artifact chain using exact staging `tested_sha`, protected `production` environment, and non-canceling concurrency; no arbitrary SHA or manual migration push.
- [ ] **Step 11: Probe production before workflow succeeds.** After migration and exact-SHA deployment, run same probe with production protected secrets. Require signed 200, public non-2xx, cleanup, and every production deploy at `tested_sha`. Persist only object-key hash, HTTP statuses, deploy IDs, workflow ID, and SHA. Runbook records protected production Supabase URL/anon/service-role values and probe email domain.

## Release 1 Verification Gate

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
bash scripts/ci/test-disposable-supabase.sh
uv run --directory artifacts/recommender-svc pytest -v
render blueprints validate render.yaml --workspace "$RENDER_WORKSPACE_ID" --confirm -o text
```

Required evidence:

- Self-role mutation fails and JWT never trusts user metadata.
- Auth/profile orphan count is zero.
- Direct Data API operational reads/writes fail.
- Recommender logs against `user_id`.
- Done tasks and filtered shipment pages return correct rows.
- Untrusted CORS, oversized questions, and timeout paths are bounded.
- TLS certificate validation is enabled in every database client.
- Public media URLs fail; signed URLs work.
- Staging and production private-media probes pass at same protected exact SHA.

## Rollback

- Auth trigger: deploy corrective forward migration; never restore role UPDATE policy.
- RLS lockdown: restore only minimum direct permission in new migration if an unidentified shipped client depends on it.
- API/Python defects: redeploy recorded last-good SHA.
- Media compatibility: redeploy old API only before bucket flip. After flip, temporarily set bucket public to restore access, fix signing, then return it to private; retain key backfill.
- Database migrations remain forward-only.
