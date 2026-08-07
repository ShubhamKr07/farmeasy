# TEN-012 Public Sign-up Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the flag-gated public "Create an account" front door — new-org-per-signup, email-verification-enforced, with flag-off Request-access capture and an unverified-account purge job — landing verified users at wizard W2.

**Architecture:** Extend the web `AuthGate` (`admin-dashboard/src/App.tsx`) with a sign-up mode gated by a backend availability endpoint. Provisioning is lazy — `ensureOwnerOrg(userId)` creates the org + owner membership idempotently at the first authed bootstrap (`GET /wizard/progress`), so email and Google-OAuth accounts share one path and `POST /facilities` stops creating the org. Email verification is required by Supabase (no session until confirmed) plus a backend defense-in-depth 403 gate; unverified accounts are purged by a named in-process daily job.

**Tech Stack:** TypeScript, Express (api-server), Drizzle + Supabase Postgres (RLS), React + Vite + wouter (admin-dashboard), Supabase Auth (`supabase.auth.signUp`/`signInWithOAuth`/`resend`), Resend email (record transport in tests), node:test + pgTAP.

## Global Constraints

- Flag `off` creates **zero** Supabase users and **zero** organization rows — Request-access capture only.
- Every successful public sign-up creates a **new** organization + owner membership; public sign-up **never** joins an existing org. Invite acceptance (TEN-010) is the sole join path.
- No product surface beyond the "Check your inbox" interstitial renders for an unverified email account — enforced client-side (guard on `email_confirmed_at`) AND server-side (`403 EMAIL_UNVERIFIED`).
- Password-policy errors surface **inline** field errors, never toasts.
- Emails stored lowercased/trimmed (TEN-010 normalization; no `citext`).
- New tables (`signup_allowlist`, `access_requests`, `account_purge_audit`) get an RLS backstop (`current_user='farmsmart_app'` per-verb policies) + a pgTAP structural test. The disposable CI DB is BYPASSRLS and masks missing RLS.
- `SIGNUP_MODE` ∈ `off|allowlist|public` (default `off`); `PURGE_UNVERIFIED_ENABLED` (default `false` in dev). TEN-011 owns the public flip; TEN-012 only reads the env.
- Org name derived from email local-part → `"<local>'s Farm"`, fallback `"My Farm"`.
- `pnpm run typecheck`, `check-tenant-scope`, pgTAP, and the api-server suite stay green; the RLS proof re-runs under a real non-BYPASSRLS `farmsmart_app` role.
- **Every task below carries an explicit Rollback block** (standing practice).

---

## File Structure

- `lib/db/src/schema/index.ts` — add `signupAllowlistTable`, `accessRequestsTable`, `accountPurgeAuditTable`.
- `lib/db/drizzle/0030_ten012_signup_tables.sql` — generated Drizzle migration (3 tables).
- `supabase/migrations/00017_ten012_signup_rls_backend_policies.sql` — enable RLS + backend policies on the 3 tables.
- `supabase/tests/00017_ten012_signup_rls.test.sql` — structural pgTAP; `supabase/tests/00001_foundation.sql` — count bumps.
- `artifacts/api-server/src/lib/signupMode.ts` — `getSignupMode()` env reader.
- `artifacts/api-server/src/lib/ensureOwnerOrg.ts` — lazy provisioning helper.
- `artifacts/api-server/src/lib/email/{index.ts,transport.ts}` — add `sendPurgeWarning`, `sendWaitlistInvite`.
- `artifacts/api-server/src/lib/purgeUnverified.ts` — purge/warn logic.
- `artifacts/api-server/src/middlewares/requireVerifiedEmail.ts` — 403 gate.
- `artifacts/api-server/src/routes/auth.ts` — `GET /auth/signup-availability`, `POST /auth/request-access`.
- `artifacts/api-server/src/routes/{wizard.ts,facilities.ts}` — wire `ensureOwnerOrg`; strip org-create.
- `artifacts/api-server/src/{app.ts,index.ts}` — mount router + gate + purge interval.
- `artifacts/admin-dashboard/src/App.tsx` + `src/pages/auth/*` — sign-up mode, interstitial, request-access.
- `artifacts/api-spec/**` + generated clients — new endpoints.
- Tests colocated per task under `artifacts/api-server/src/tests/**`.

---

### Task 1: Sign-up DB tables (schema + Drizzle migration)

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0030_ten012_signup_tables.sql` (via `pnpm --filter @workspace/db run db:generate`)
- Test: `artifacts/api-server/src/tests/db/signupTables.test.ts`

**Interfaces:**
- Produces: `signupAllowlistTable` (id serial pk, email text unique, createdAt), `accessRequestsTable` (id, email text unique, farmName text, createdAt, notifiedAt timestamp nullable), `accountPurgeAuditTable` (id, userId uuid, email text, action text, at timestamp). All consumed by later tasks.

- [ ] **Step 1: Write the failing test** — `signupTables.test.ts` inserts+reads one row per table via `getAdminDb()`; asserts email unique constraint rejects a dup.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAdminDb } from "../helpers/testDatabase.js";

const admin = getAdminDb();
describe("TEN-012 signup tables", { skip: !admin }, () => {
  it("signup_allowlist enforces unique email", async () => {
    const { signupAllowlistTable } = await import("@workspace/db");
    await admin!.insert(signupAllowlistTable).values({ email: "t1@example.com" });
    await assert.rejects(admin!.insert(signupAllowlistTable).values({ email: "t1@example.com" }));
  });
  it("access_requests + purge audit accept rows", async () => {
    const { accessRequestsTable, accountPurgeAuditTable } = await import("@workspace/db");
    await admin!.insert(accessRequestsTable).values({ email: "w1@example.com", farmName: "W1 Farm" });
    await admin!.insert(accountPurgeAuditTable).values({
      userId: "00000000-0000-4000-8000-0000000000aa", email: "w1@example.com", action: "warned",
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/db/signupTables.test.ts` → FAIL (tables/exports missing).

- [ ] **Step 3: Add the three tables** to `lib/db/src/schema/index.ts` (match the `pgTable` style used by `invitationsTable`):

```ts
export const signupAllowlistTable = pgTable("signup_allowlist", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const accessRequestsTable = pgTable("access_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  farmName: text("farm_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  notifiedAt: timestamp("notified_at"),
});

export const accountPurgeAuditTable = pgTable("account_purge_audit", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  email: text("email").notNull(),
  action: text("action").notNull(), // 'warned' | 'purged'
  at: timestamp("at").notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate the migration** — `pnpm --filter @workspace/db run db:generate` produces `0030_ten012_signup_tables.sql`; confirm it contains the 3 `CREATE TABLE`s + unique indexes.

- [ ] **Step 5: Apply + run test** — apply to the disposable DB (`DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/db run db:migrate`), rerun Step 2's command → PASS.

- [ ] **Step 6: Commit** — `git add lib/db/src/schema/index.ts lib/db/drizzle/0030_ten012_signup_tables.sql artifacts/api-server/src/tests/db/signupTables.test.ts && git commit -m "feat(db): TEN-012 signup_allowlist/access_requests/account_purge_audit tables"`

**Rollback:** revert the schema block + delete `0030_*.sql`; down-migration = `DROP TABLE signup_allowlist, access_requests, account_purge_audit;`. Additive only — no existing data touched. Safe to drop while unused.

---

### Task 2: RLS backstop + pgTAP for the 3 tables

**Files:**
- Create: `supabase/migrations/00017_ten012_signup_rls_backend_policies.sql`
- Create: `supabase/tests/00017_ten012_signup_rls.test.sql`
- Modify: `supabase/tests/00001_foundation.sql` (Drizzle 30→31, Supabase 16→17)

**Interfaces:**
- Consumes: the 3 tables from Task 1.
- Produces: RLS enabled + `current_user='farmsmart_app'` per-verb policies so backend reads/writes succeed under the non-BYPASSRLS role.

- [ ] **Step 1: Write the migration** — mirror `00016_invitations_rls_backend_policies.sql`:

```sql
-- 00017_ten012_signup_rls_backend_policies.sql
-- TEN-012: enable RLS on the three sign-up tables and grant the backend's own
-- farmsmart_app role per-verb access (same current_user-scoped model as
-- organization_members 00011/00012/00014 and invitations 00016). These tables
-- hold PII (waitlist emails/farm names, purge-audit emails); the disposable CI
-- DB is a BYPASSRLS superuser and would mask a missing backstop.
alter table public.signup_allowlist enable row level security;
alter table public.access_requests enable row level security;
alter table public.account_purge_audit enable row level security;

-- signup_allowlist: backend reads (availability) + admin insert/delete.
create policy "backend reads signup_allowlist" on public.signup_allowlist
  for select using (current_user = 'farmsmart_app');
create policy "backend writes signup_allowlist" on public.signup_allowlist
  for insert with check (current_user = 'farmsmart_app');
create policy "backend deletes signup_allowlist" on public.signup_allowlist
  for delete using (current_user = 'farmsmart_app');

-- access_requests: backend upsert (capture) + read/update (notify).
create policy "backend reads access_requests" on public.access_requests
  for select using (current_user = 'farmsmart_app');
create policy "backend inserts access_requests" on public.access_requests
  for insert with check (current_user = 'farmsmart_app');
create policy "backend updates access_requests" on public.access_requests
  for update using (current_user = 'farmsmart_app') with check (current_user = 'farmsmart_app');

-- account_purge_audit: backend inserts (warn/purge) + reads.
create policy "backend reads account_purge_audit" on public.account_purge_audit
  for select using (current_user = 'farmsmart_app');
create policy "backend inserts account_purge_audit" on public.account_purge_audit
  for insert with check (current_user = 'farmsmart_app');
```

- [ ] **Step 2: Write the pgTAP test** — structural (mirror `00016_invitations_rls.test.sql`): for each of the 3 tables assert `relrowsecurity` true and policy count matches (3/3/2), and `coalesce(qual,with_check) LIKE '%farmsmart_app%'` for all. `SELECT plan(9)`.

- [ ] **Step 3: Bump foundation counts** in `00001_foundation.sql` — Drizzle `30 → 31` (one new migration file) and Supabase `16 → 17`, updating both the `is(...)` values and the two assertion message strings; append a one-line note describing 00017.

- [ ] **Step 4: Apply + run pgTAP** — apply 00017 to the disposable DB, record `('00017')` in `supabase_migrations.schema_migrations`, then `pnpm exec supabase test db --db-url "$TEST_DATABASE_URL" ./supabase/tests` → PASS (all files, new one included).

- [ ] **Step 5: Commit** — `git commit -am "feat(auth): RLS backstop + pgTAP for TEN-012 signup tables"`

**Rollback:** down = `DROP POLICY ...` (all above) then `alter table ... disable row level security;` for the 3 tables; revert the foundation-count edit. Reverse dependency order: drop policies before dropping tables (Task 1's rollback).

---

### Task 3: `SIGNUP_MODE` reader + `GET /auth/signup-availability`

**Files:**
- Create: `artifacts/api-server/src/lib/signupMode.ts`
- Create: `artifacts/api-server/src/routes/auth.ts`
- Test: `artifacts/api-server/src/tests/routes/auth-availability.test.ts`

**Interfaces:**
- Produces: `getSignupMode(): "off"|"allowlist"|"public"`; `createAuthRouter(): Router` exposing `GET /auth/signup-availability?email=` → `{ mode, allowed }`.

- [ ] **Step 1: Write failing tests** — table-driven: `off`→`{mode:"off",allowed:false}`; `allowlist`+email in `signup_allowlist`→`allowed:true`, absent→`false`; `public`→`allowed:true`. Email normalized (uppercase input matches lowercased row). Use `createTestApp` mounting only `createAuthRouter()`; seed allowlist via `getAdminDb()`; set `process.env.SIGNUP_MODE` per case.

```ts
const res = await request(app).get("/auth/signup-availability").query({ email: "Tester@Example.com " });
assert.deepEqual(res.body, { mode: "allowlist", allowed: true });
```

- [ ] **Step 2: Run tests, verify fail** — route missing → 404.

- [ ] **Step 3: Implement `signupMode.ts`**

```ts
export type SignupMode = "off" | "allowlist" | "public";
export function getSignupMode(): SignupMode {
  const v = (process.env.SIGNUP_MODE ?? "off").toLowerCase();
  return v === "allowlist" || v === "public" ? v : "off";
}
```

- [ ] **Step 4: Implement `auth.ts`** — normalize email (`.trim().toLowerCase()`), own rate limiter (mirror `wizard-events.ts`), no auth:

```ts
router.get("/auth/signup-availability", availabilityLimiter, async (req, res) => {
  const mode = getSignupMode();
  const email = String(req.query.email ?? "").trim().toLowerCase();
  if (mode === "off") return res.json({ mode, allowed: false });
  if (mode === "public") return res.json({ mode, allowed: true });
  if (!email) return res.json({ mode, allowed: false });
  const [row] = await db.select({ id: signupAllowlistTable.id })
    .from(signupAllowlistTable).where(eq(signupAllowlistTable.email, email)).limit(1);
  return res.json({ mode, allowed: Boolean(row) });
});
```

- [ ] **Step 5: Run tests → PASS.**

- [ ] **Step 6: Commit** — `git commit -am "feat(auth): GET /auth/signup-availability + SIGNUP_MODE reader (TEN-012)"`

**Rollback:** remove `auth.ts`'s availability route + `signupMode.ts`; unmount in Task 9's app wiring. No DB/schema effect. `SIGNUP_MODE` unset → defaults `off` (closed).

---

### Task 4: `POST /auth/request-access` (flag-off waitlist capture)

**Files:**
- Modify: `artifacts/api-server/src/routes/auth.ts`
- Test: `artifacts/api-server/src/tests/routes/auth-request-access.test.ts`

**Interfaces:**
- Produces: `POST /auth/request-access { email, farmName }` → 201; upserts `access_requests` on email; **never** creates auth/org rows.

- [ ] **Step 1: Write failing tests** — valid body → 201 + row exists; second submit same email updates `farm_name` (no dup, `notified_at` untouched); missing/invalid email → 400; assert `auth.users` count unchanged (via `getAdminDb`).

- [ ] **Step 2: Run → fail** (404).

- [ ] **Step 3: Implement** — zod-validate `{ email: z.string().email(), farmName: z.string().min(1).max(120) }`; normalize email; upsert:

```ts
await db.insert(accessRequestsTable)
  .values({ email, farmName })
  .onConflictDoUpdate({ target: accessRequestsTable.email, set: { farmName } });
return res.status(201).json({ ok: true });
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(auth): POST /auth/request-access waitlist capture (TEN-012)"`

**Rollback:** remove the route handler. `access_requests` rows are inert PII — Task 1/2 rollback drops the table. No account side effects to unwind.

---

### Task 5: `ensureOwnerOrg` + wire bootstrap + strip org-create from `POST /facilities`

**Files:**
- Create: `artifacts/api-server/src/lib/ensureOwnerOrg.ts`
- Modify: `artifacts/api-server/src/routes/wizard.ts` (call at start of `GET /wizard/progress`)
- Modify: `artifacts/api-server/src/routes/facilities.ts` (remove org+owner create branch)
- Test: `artifacts/api-server/src/tests/lib/ensureOwnerOrg.test.ts`, extend `facilities` route test

**Interfaces:**
- Consumes: `organizationsTable`, `organizationMembersTable`, `invitationsTable`.
- Produces: `ensureOwnerOrg(userId: string, email: string): Promise<{ organizationId: number; created: boolean }>`.

- [ ] **Step 1: Write failing tests** — (a) fresh user, no membership, no invite → creates org named `"<local>'s Farm"` + owner membership; `created:true`. (b) second call → idempotent, same org, `created:false`. (c) user whose email has a pending invite → does NOT provision, throws/returns a sentinel (`created:false, organizationId:null`-style) — assert no org row created. (d) name fallback: email with empty local-part edge → `"My Farm"`. Run under `getAdminDb` seeding.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `ensureOwnerOrg.ts`** — one transaction, `FOR UPDATE` idempotency:

```ts
export async function ensureOwnerOrg(userId: string, email: string) {
  return db.transaction(async (tx) => {
    const [membership] = await tx.select({ organizationId: organizationMembersTable.organizationId })
      .from(organizationMembersTable)
      .where(and(eq(organizationMembersTable.userId, userId), eq(organizationMembersTable.status, "active")))
      .limit(1).for("update");
    if (membership) return { organizationId: membership.organizationId, created: false };

    const [invite] = await tx.select({ id: invitationsTable.id }).from(invitationsTable)
      .where(and(eq(invitationsTable.email, email.toLowerCase()), eq(invitationsTable.status, "pending")))
      .limit(1);
    if (invite) return { organizationId: null, created: false }; // invite path owns this user

    const local = email.split("@")[0]?.trim();
    const name = local ? `${local}'s Farm` : "My Farm";
    const [org] = await tx.insert(organizationsTable).values({ name }).returning();
    await tx.insert(organizationMembersTable).values({
      organizationId: org.id, userId, role: "owner", status: "active",
    });
    return { organizationId: org.id, created: true };
  });
}
```

- [ ] **Step 2b (design note):** the legacy `users.organizationId` column is deprecated (slated for drop). `ensureOwnerOrg` does NOT set it; `POST /facilities` currently does — remove that write in Step 4 too, matching the deprecation direction.

- [ ] **Step 3b: Call at bootstrap** — in `wizard.ts` `GET /wizard/progress`, immediately after `getAuth(req)`, call `await ensureOwnerOrg(userId!, getAuth(req).email)` (thread the email from the verified JWT; add it to `getAuth` if not present). Guard: only when no `facilityId` param (the first-run case).

- [ ] **Step 4: Strip org-create from `facilities.ts`** — replace the `if (existingMembership) {...} else {create org+owner+users.orgId}` block with: resolve `organizationId` from the (now guaranteed) active membership; if none, `500 { error: "No organization for user" }` (should never happen post-bootstrap). Remove the `organizationsTable`/`usersTable.organizationId` writes.

- [ ] **Step 5: Run tests → PASS**; extend facilities route test to assert it now requires a pre-existing membership and creates only the facility + rooms.

- [ ] **Step 6: `check-tenant-scope`** — `ensureOwnerOrg`'s org-membership reads mirror the existing bootstrap exceptions; add baseline entries if flagged (group like TEN-008's).

- [ ] **Step 7: Commit** — `git commit -am "feat(auth): lazy ensureOwnerOrg at wizard bootstrap; facilities.ts stops creating org (TEN-012)"`

**Rollback (has a point-of-no-return note):** the `facilities.ts` change is a **code revert** (restore the org-create branch guarded on "membership missing") — safe because it was idempotent. `ensureOwnerOrg` is additive; a provisioned org with no facility is deletable. No destructive migration. Deploy order matters: ship `ensureOwnerOrg` + bootstrap wiring BEFORE the `facilities.ts` strip, so no window exists where neither creates the org.

---

### Task 6: `requireVerifiedEmail` backend gate

**Files:**
- Create: `artifacts/api-server/src/middlewares/requireVerifiedEmail.ts`
- Modify: `artifacts/api-server/src/app.ts` (mount ahead of tenant-scoped routers)
- Test: `artifacts/api-server/src/tests/middlewares/requireVerifiedEmail.test.ts`, extend `app.test.ts`

**Interfaces:**
- Produces: middleware → `403 { code:"EMAIL_UNVERIFIED" }` when the verified JWT has `email_confirmed_at`/`email_verified` falsey; passthrough otherwise.

- [ ] **Step 1: Write failing tests** — stub `req.auth`/claims: unverified → 403 `EMAIL_UNVERIFIED`; verified → `next()`. In `app.test.ts`, a verified session still reaches a protected route; an unverified one is blocked but the auth/availability/request-access routes remain reachable (they mount before the gate).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — read the confirmation claim from the same verified-JWT source `supabaseAuth.ts` populates (`req.auth`/user metadata); fail closed:

```ts
export function requireVerifiedEmail(req, res, next) {
  const u = getAuth(req); // { userId, email, emailVerified }
  if (!u.emailVerified) return res.status(403).json({ code: "EMAIL_UNVERIFIED" });
  next();
}
```
(Extend `getAuth`/`supabaseAuth.ts` to surface `emailVerified` from `email_confirmed_at`/`user_metadata.email_verified`.)

- [ ] **Step 4: Mount** in `app.ts` — after `requireSignedIn`, before the tenant-scoped tiers, but AFTER the public `auth`/availability/request-access + accept routes. Verify tier ordering with `app.test.ts`.

- [ ] **Step 5: Run → PASS.**

- [ ] **Step 6: Commit** — `git commit -am "feat(auth): requireVerifiedEmail 403 gate + JWT emailVerified plumb (TEN-012)"`

**Rollback:** unmount the middleware in `app.ts` (one-line revert) + revert the `getAuth` field. Primary control (Supabase confirm-email-required) still holds even if this is reverted. No schema effect.

---

### Task 7: Email lib — purge-warning + waitlist-invite; `notifyWaitlist`

**Files:**
- Modify: `artifacts/api-server/src/lib/email/{index.ts,transport.ts}`
- Create: `artifacts/api-server/src/lib/notifyWaitlist.ts`
- Test: `artifacts/api-server/src/tests/lib/email-ten012.test.ts`

**Interfaces:**
- Produces: `sendPurgeWarning({ to })`, `sendWaitlistInvite({ to })` (Resend prod / record transport tests, `escapeHtml` on any dynamic text); `notifyWaitlist(): Promise<{ sent: number }>` — emails un-notified `access_requests` rows, stamps `notified_at`.

- [ ] **Step 1: Write failing tests** — with `EMAIL_TRANSPORT=record`: `sendPurgeWarning`/`sendWaitlistInvite` record subject+recipient; `notifyWaitlist` sends exactly one per un-notified row, stamps `notified_at`, and is idempotent (second call sends 0).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** the two senders (mirror `sendInvite` structure) and `notifyWaitlist` (select `notified_at IS NULL`, send, `update ... set notified_at = now()` per row).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(email): purge-warning + waitlist-invite senders + notifyWaitlist (TEN-012)"`

**Rollback:** remove the two senders + `notifyWaitlist.ts`. `notifyWaitlist` is not wired to any trigger in TEN-012 (TEN-011 fires it later), so removal has no runtime caller to break. Idempotent + additive.

---

### Task 8: Unverified-account purge job

**Files:**
- Create: `artifacts/api-server/src/lib/purgeUnverified.ts`
- Modify: `artifacts/api-server/src/index.ts` (daily `setInterval`, env-gated)
- Test: `artifacts/api-server/src/tests/lib/purgeUnverified.test.ts`

**Interfaces:**
- Consumes: Supabase admin API (`auth.admin.listUsers`/`deleteUser`), `sendPurgeWarning`, `accountPurgeAuditTable`, `ensureOwnerOrg`'s org.
- Produces: `purgeUnverifiedAccounts(now?: Date): Promise<{ warned: number; purged: number }>`.

- [ ] **Step 1: Write failing tests** (inject `now`; stub admin API + email record): spares verified accounts; spares unverified < 7d; warns unverified ≥ 7d once (audit `warned`, email sent); purges unverified ≥ 10d — deletes user + their org **only if that org has no facilities**, writes audit `purged`; never touches an org that has a facility (logs + skips).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — enumerate unverified users (email_confirmed_at null); for each compute age from `created_at`:
  - `≥10d`: find their owner org; if it has 0 facilities → `admin.deleteUser` + delete org (cascades membership) + audit `purged`; else skip (data present — never auto-delete real data).
  - `≥7d` and no prior `warned` audit → `sendPurgeWarning` + audit `warned`.
  Guarded by `getSignupMode`-independent env `PURGE_UNVERIFIED_ENABLED === "true"`.

- [ ] **Step 4: Wire interval** in `index.ts` (mirror overdue-scanner): `if (process.env.PURGE_UNVERIFIED_ENABLED === "true") setInterval(() => purgeUnverifiedAccounts().catch(log), 24*60*60*1000);` plus one run on boot.

- [ ] **Step 5: Run → PASS.**

- [ ] **Step 6: Commit** — `git commit -am "feat(auth): unverified-account purge job (warn d7, purge d10, audited) (TEN-012)"`

**Rollback (point-of-no-return):** set `PURGE_UNVERIFIED_ENABLED=false` — halts immediately, no redeploy of code needed. The day-10 `deleteUser` + org delete is **irreversible**; it is gated to unverified + ≥10d + zero-facility orgs and every action is written to `account_purge_audit` before deletion. Code rollback = remove the `index.ts` interval + `purgeUnverified.ts`.

---

### Task 9: Web AuthGate sign-up mode

**Files:**
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Create: `artifacts/admin-dashboard/src/pages/auth/SignUpForm.tsx`, `src/hooks/use-signup-availability.ts`
- Test: `artifacts/admin-dashboard/src/pages/auth/SignUpForm.test.tsx`

**Interfaces:**
- Consumes: `GET /auth/signup-availability`. Produces: a Create-account form (email+password, inline password errors, Google) that on email `signUp` transitions to the interstitial (Task 10) and on `off`/not-allowed renders Request-access (Task 11).

- [ ] **Step 1: Write failing tests** — mode `public` renders Create-account; submitting valid email+weak password shows an **inline** field error (not a toast); valid submit calls `supabase.auth.signUp` and transitions to interstitial state; mode `off` renders Request-access. Mock supabase client + fetch.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — `use-signup-availability(email)` debounced fetch; `SignUpForm` with a Sign-in↔Create-account toggle added to the existing `!session` block in `App.tsx`; inline password validation (min 8, mirror Supabase policy) rendered as field text; Google via `signInWithOAuth`.

- [ ] **Step 4: Run → PASS**; manual `pnpm --filter @workspace/admin-dashboard run build` clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): AuthGate sign-up mode + availability wiring (TEN-012)"`

**Rollback:** revert `App.tsx` to the sign-in-only block; delete the new files. UI-only; no data/schema. With `SIGNUP_MODE=off` the surface already degrades to Request-access, so partial rollback is safe.

---

### Task 10: "Check your inbox" verification interstitial

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/auth/VerifyInterstitial.tsx`
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Test: `artifacts/admin-dashboard/src/pages/auth/VerifyInterstitial.test.tsx`

**Interfaces:**
- Consumes: `supabase.auth.resend`. Produces: interstitial shown after email sign-up and for any unverified session; Resend + Change-email actions; blocks all other surfaces.

- [ ] **Step 1: Write failing tests** — renders "Check your inbox" with the entered email; Resend calls `supabase.auth.resend({ type:"signup", email })`; Change-email returns to the form; an unverified `session` (email_confirmed_at null) renders ONLY the interstitial, never the app shell.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — in `App.tsx`, before the org-role gate: if `session && !session.user.email_confirmed_at` → render `VerifyInterstitial`. OAuth sessions are already confirmed, so they skip it.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): email-verification interstitial (resend/change-email) (TEN-012)"`

**Rollback:** revert `App.tsx` guard + delete the component. The backend `requireVerifiedEmail` gate (Task 6) still blocks unverified accounts server-side, so security holds even if this UI is reverted.

---

### Task 11: Request-access form (flag-off)

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/auth/RequestAccessForm.tsx`
- Test: `artifacts/admin-dashboard/src/pages/auth/RequestAccessForm.test.tsx`

**Interfaces:**
- Consumes: `POST /auth/request-access`. Produces: email + farm-name capture with success copy; no account created.

- [ ] **Step 1: Write failing tests** — submit posts `{ email, farmName }`, shows success copy; validation errors inline; the component is what `SignUpForm` renders when availability is `off`/not-allowed.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** the form + wire into `SignUpForm`'s `off` branch.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): flag-off Request-access capture form (TEN-012)"`

**Rollback:** delete the component + revert the `SignUpForm` branch. UI-only, no side effects.

---

### Task 12: OpenAPI spec + client codegen

**Files:**
- Modify: `artifacts/api-spec/**` (paths for `/auth/signup-availability`, `/auth/request-access`)
- Regenerate: dashboard/mobile generated clients (`pnpm --filter @workspace/api-spec run codegen`)
- Test: codegen-drift check (CI "Quality" job)

- [ ] **Step 1: Add the two paths** to the OpenAPI source with request/response schemas matching Tasks 3–4.

- [ ] **Step 2: Run codegen** — `pnpm --filter @workspace/api-spec run codegen`; confirm generated hooks appear (`useGetSignupAvailability` query, `usePostRequestAccess` mutation per orval conventions).

- [ ] **Step 3: Point the web forms** at the generated hooks (replace ad-hoc `fetch` from Tasks 9/11 where practical).

- [ ] **Step 4: Typecheck** — `pnpm run typecheck` clean; codegen-drift check clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(api-spec): signup-availability + request-access endpoints + client codegen (TEN-012)"`

**Rollback:** revert the api-spec paths + regenerate (drops the generated hooks); revert the form wiring to the ad-hoc fetch. No runtime/schema effect.

---

### Task 13: End-to-end integration under real `farmsmart_app` RLS + live email

**Files:**
- Create: `artifacts/api-server/src/tests/integration/ten012-signup.test.ts`
- Create: `artifacts/api-server/src/tests/integration/ten012-verification-email.test.ts` (gated on Mailosaur + Resend + EMAIL_FROM, TEN-010 pattern)

- [ ] **Step 1: Provisioning + gate under farmsmart_app** — with the app connecting as the non-BYPASSRLS `farmsmart_app` role (admin conn for fixtures): a fresh verified user hitting `GET /wizard/progress` gets exactly one org + owner membership (idempotent on repeat); an unverified user is `403 EMAIL_UNVERIFIED`; `request-access` inserts with zero auth/org rows; availability reflects the seeded allowlist.

- [ ] **Step 2: Purge under farmsmart_app** — seed verified/unverified/aged fixtures; `purgeUnverifiedAccounts(fakeNow)` warns/purges exactly the right rows and writes audit rows admissible under RLS.

- [ ] **Step 3: Live verification email** (not skipped) — drive an actual sign-up whose Supabase confirmation email is captured in Mailosaur; assert subject + confirm link presence + spam ≤ 5. (Mirror TEN-010's `invite-email.test.ts` gating.)

- [ ] **Step 4: Run the full suite as postgres** (`pnpm --filter @workspace/api-server run test`) → all green; then the farmsmart_app RLS re-run of the new integration files → green.

- [ ] **Step 5: Commit** — `git commit -am "test(auth): TEN-012 e2e provisioning/gate/purge under farmsmart_app RLS + live verification email"`

**Rollback:** tests only — deletion has no production effect.

---

## Verification (whole plan, before PR)

- `pnpm run typecheck`, `check-tenant-scope`, pgTAP (counts bumped), and the api-server suite all green.
- RLS proof: the new provisioning/availability/request-access/purge paths re-run under a real non-BYPASSRLS `farmsmart_app` role.
- Live verification email captured (not skipped).
- Whole-branch review on the most capable model before `finishing-a-development-branch`.

## Self-review notes (author)

- **Spec coverage:** flag/allowlist (T3), Create-account + inline password (T9), interstitial + resend/change-email (T10), OAuth-skips-interstitial (T10 guard), new-org-per-signup + never-join (T5), request-access no-account (T4/T11), verification enforcement client+server (T6/T10), purge (warn d7/purge d10) + warning + audit + named job (T7/T8), waitlist notification function (T7, fired by TEN-011), password errors inline not toasts (T9/T11), RLS on new tables (T2), land at W2 (T5 bootstrap). All mapped.
- **Type consistency:** `ensureOwnerOrg(userId, email) → { organizationId, created }` used identically in T5 bootstrap and T13; `{ mode, allowed }` shape identical T3↔T9; `EMAIL_UNVERIFIED` code identical T6↔T13.
- **Deploy ordering** (T5 rollback note) is the one cross-task hazard: provisioning must ship before the `facilities.ts` org-create strip.
