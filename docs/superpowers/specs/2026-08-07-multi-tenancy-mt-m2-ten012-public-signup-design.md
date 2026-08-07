# TEN-012 · Public Sign-up Surface — Design

**Scope of this document:** the third of five sub-projects decomposed out of MT-M2 ("Multi-facility + front door": TEN-008, TEN-010 rev. B, TEN-012, TEN-013, TEN-009 stubs). TEN-008 (multi-facility ops, PR #12) and TEN-010 rev. B (team invites/roles, PR #13) shipped. This document covers **TEN-012 only** — the public "Create an account" sign-up surface, its flag/allowlist gating, lazy org provisioning, email-verification enforcement, the flag-off "Request access" capture, and the unverified-account purge job. TEN-013 (demo mode / post-sign-up fork), TEN-009 (org rollup stubs), and TEN-011's public flag flip are each their own future sub-project, not covered here.

**Landing decision (this sub-project):** post-verification lands the user directly in the existing onboarding wizard at **W2** (`farm_basics`). The TEN-013 fork ("Set up your farm" vs "Explore a demo") is deferred; TEN-013 will later reroute W2 through the fork. TEN-012 builds nothing of the fork.

---

## Goal

Ship the product's front door: a flag-gated public sign-up that creates exactly one new organization per account (never joins an existing org — invite acceptance remains the sole join path), enforces email verification before any product surface renders, and cleans up accounts that never verify.

## Architecture (2–3 sentences)

Extend the existing web `AuthGate` (`admin-dashboard/src/App.tsx`, today sign-in-only) with a sign-up mode driven by a backend availability endpoint. Provisioning is **lazy**: the backend creates the org + owner membership idempotently on the first authenticated request that finds no membership and no invite tie, so both email/password and Google-OAuth accounts converge on one path, and W2 stops creating the org. Email verification is required by Supabase (no session until confirmed) with a backend defense-in-depth gate; unverified accounts are purged by a named in-process scheduled job.

---

## Global Constraints

- Flag `off` creates **zero** Supabase users and **zero** organization rows — Request-access capture only.
- Every successful public sign-up creates a **new** organization + owner membership. Public sign-up **never** joins an existing org. Invite acceptance (TEN-010) is the sole, distinct join path.
- No product surface beyond the "Check your inbox" verification interstitial renders for an unverified email account (enforced client- and server-side).
- Password-policy errors surface **inline**, never as toasts.
- New tenant/PII tables get an RLS backstop (`current_user='farmsmart_app'` per-verb policies) + a pgTAP structural test — the TEN-010 final-review lesson: a table shipped without RLS is the class of bug the BYPASSRLS CI DB masks.
- `pnpm run typecheck`, `check-tenant-scope`, pgTAP, and the api-server suite stay green; the RLS proof re-runs under a real non-BYPASSRLS `farmsmart_app` role.
- **Every implementation-plan task carries explicit rollback steps** (down-migration / `DROP POLICY` / env-flip / revert), with the point-of-no-return called out — standing practice.

---

## Components

### 1. Flag & availability (`SIGNUP_MODE` + allowlist)

- **Backend env** `SIGNUP_MODE` ∈ `off | allowlist | public` (default `off`). TEN-011 owns the public flip and its CI/config gate; TEN-012 only reads the value.
- **Table** `signup_allowlist(id, email text unique, created_at)` — tester emails for `allowlist` mode; email stored lowercased/trimmed (TEN-010 normalization pattern — no `citext` dependency). RLS backstop: backend-role policies (read/insert/delete).
- **Endpoint** `GET /auth/signup-availability?email=<addr>` → `{ mode, allowed }`:
  - `off` → `{ mode:"off", allowed:false }`
  - `allowlist` → `allowed` = email ∈ `signup_allowlist`
  - `public` → `{ mode:"public", allowed:true }`
  - Public (no auth). Email normalized (lowercased/trimmed). Rate-limited (own limiter, mirrors `wizard-events.ts`).

### 2. AuthGate sign-up mode (web, `App.tsx`)

- Toggle **Sign in ↔ Create account**. On mount / email entry, call `signup-availability`.
- **`create-account` (mode ≠ off, allowed):** email + password fields with **inline** password-policy validation (min length + Supabase policy echoed client-side; server is source of truth). Google button (`signInWithOAuth`). On email `supabase.auth.signUp` → Supabase sends confirmation → render **"Check your inbox"** interstitial with **Resend** (`auth.resend`) and **Change email** (returns to form). OAuth redirect → on return, verified session skips the interstitial.
- **`off` (or not allowlisted):** **Request access** form (email + farm name) → `POST /auth/request-access` → success copy. No account, no org.
- Interstitial is the only surface an unverified session can see (client guard on `email_confirmed_at`).

### 3. Lazy org provisioning (`ensureOwnerOrg`)

- New backend helper `ensureOwnerOrg(userId): { organizationId }`. In one transaction, `SELECT ... FOR UPDATE`-guarded and idempotent:
  - If the user already has a membership → return it (no-op).
  - If a pending/accepted invitation ties this user's email to an org → **do not** provision (invite path owns them); surface a clear state.
  - Else create `organizations(name)` + `organization_members(role='owner', status='active')`.
- **Org name:** derived from the email local-part → `"<local>'s Farm"`, fallback `"My Farm"`; renamed later in the wizard.
- **Called at** the first authed bootstrap — `GET /wizard/progress` (already the first authed wizard call) invokes it before returning, guaranteeing the org exists before W2.
- **W2 change:** `POST /facilities` no longer creates the org (it always exists now) — it creates only the facility (+ its wizard bookkeeping). The owner-membership insert there is removed.
- **Rollback:** provisioning is additive; a provisioned org with no facility is safe to delete. The `POST /facilities` change is a code revert (re-add the org-create branch, guarded on "org missing").

### 4. Verification enforcement

- Supabase project configured to **require email confirmation** (no session issued until verified) — the primary control.
- **Backend defense-in-depth:** middleware rejects any request whose verified JWT carries `email_confirmed_at = null` → `403 { code:"EMAIL_UNVERIFIED" }`. Mounted ahead of tenant-scoped routers.
- Net: only verified accounts reach the wizard/app; the interstitial is driven by local sign-up state, not a live session.

### 5. Request-access / waitlist

- **Table** `access_requests(id, email text unique, farm_name text, created_at, notified_at nullable)` — email lowercased/trimmed. RLS backstop (backend-role policies).
- `POST /auth/request-access` (public, rate-limited) upserts on email (last farm_name wins), never creates auth/org rows.
- **Notification-on-enablement:** a `notifyWaitlist()` function emails un-notified rows and stamps `notified_at`. TEN-012 provides + unit-tests it; TEN-011 fires it on the public flip and retires the capture form.

### 6. Unverified purge job

- In-process `setInterval` (daily), same pattern as `overdue-scanner.ts`, gated by env `PURGE_UNVERIFIED_ENABLED` (default off in dev).
- `purgeUnverifiedAccounts()`:
  - **Warn (day 7):** unverified accounts aged ≥ 7d with no warning yet → send one warning email, record it.
  - **Purge (day 10):** unverified accounts aged ≥ 10d → delete the Supabase user (admin API) + the org row provisioned for them (guard: only their own, only if no facility/data), write an audit row.
- **Table** `account_purge_audit(id, user_id, email, action 'warned'|'purged', at)`.
- **Rollback:** env-flip `PURGE_UNVERIFIED_ENABLED=false` halts it immediately; the job is otherwise additive. Point-of-no-return: the day-10 delete is irreversible — it runs only on unverified, ≥10d, data-less accounts, and is audited.

---

## Data flow

1. Visitor opens dashboard → AuthGate calls `signup-availability`.
2. **off / not allowlisted:** Request-access form → `access_requests` row. End.
3. **create-account (email):** `signUp` → confirmation email → interstitial (resend / change-email). Verify link → session issued → dashboard bootstrap `GET /wizard/progress` → `ensureOwnerOrg` creates org+owner → wizard opens at W2 → `POST /facilities` creates the first facility.
4. **create-account (OAuth):** Google redirect → verified session → same bootstrap → W2.
5. **Never verifies:** day-7 warning email; day-10 purge (user + data-less org) + audit.

## Error handling

- Password policy → inline field errors (not toasts). Duplicate email on sign-up → clear "account exists, sign in / reset" copy (no user enumeration beyond Supabase's own behavior). Availability endpoint failure → fail closed to Request-access. `ensureOwnerOrg` race → `FOR UPDATE` + idempotent re-check; invite-tie → explicit non-provision state. Unverified request → `403 EMAIL_UNVERIFIED`.

## Testing

- **Unit:** availability modes (off/allowlist/public × allowed/not); password-policy inline errors; `ensureOwnerOrg` idempotency + invite-exclusion + name derivation; `access_requests` upsert; `notifyWaitlist` (record transport); purge selection logic (spares verified, spares <7d, day-7 warn once).
- **Integration under real `farmsmart_app` RLS:** provisioning creates exactly one org + owner; unverified JWT → 403; request-access inserts with no auth/org; purge deletes only unverified+≥10d+data-less and its org, spares everyone else.
- **pgTAP:** new tables (`signup_allowlist`, `access_requests`, `account_purge_audit`) exist with RLS enabled + backend policies; foundation migration-count bumped.
- **Live email:** verification + warning emails driven Resend→Mailosaur (TEN-010 pattern), asserting delivery + no-leak.

## Out of scope (explicit)

TEN-013 fork/demo; TEN-011 public flag flip + its CI gate + the actual waitlist-notification firing; password reset (AUTH-002); login redesign (AUTH-003); mobile sign-in policy (TEN-014); per-facility membership/RBAC.

## Rollback (whole sub-project)

Flag `SIGNUP_MODE=off` + `PURGE_UNVERIFIED_ENABLED=false` neutralizes the live surface and the destructive job without a revert. Schema is additive (three new tables, all droppable); the one behavioral change to existing code (`POST /facilities` no longer creating the org) is a guarded code revert. Per-task rollbacks are enumerated in the implementation plan.
