# TEN-010 rev. B — Team Invitations and Roles Design

**Scope of this document:** the second of five sub-projects decomposed out of MT-M2 ("Multi-facility + front door": TEN-008, TEN-010 rev. B, TEN-012, TEN-013, TEN-009 stubs). TEN-008 (multi-facility ops) shipped (PR #12, merged). This document covers **TEN-010 rev. B only** — team invitations, the org role model (owner/admin/technician), server-side role enforcement, and the Settings → Team dashboard surface. TEN-012 (public sign-up), TEN-013 (demo mode), TEN-009 (org rollup stubs), and TEN-014 (mobile entry policy) are each their own future sub-project, not covered here.

**PRD requirement:** TEN-010 (rev. B) · Team invitations and roles — dashboard capability, never onboarding [P0]. "Settings → Team on the web dashboard, visible to owner and admin roles only. Owner/admin invites a member by email with a role — admin (full web dashboard + mobile app) or technician (mobile app only). Invites are tokenised, single-use, expiring (14-day default), revocable; acceptance creates the Supabase user if needed and the membership with its role. Role gating is enforced server-side: session middleware resolves role alongside org context, and web-only API surfaces reject technician sessions regardless of client. Explicitly NOT part of the onboarding journey: no wizard step, no readiness-checklist item, no W4 mention."

## 1. Current-state audit

- **The org role model already exists at the data layer.** `organization_members` (MT-M0) has `role` (`org_member_role` enum: `owner | admin | technician`) and `status` (`org_member_status` enum: `active | removed`), with a `UNIQUE(user_id)` index enforcing one-org-per-user (TEN-001). `resolveTenantContext` (MT-M1/TEN-008) already resolves `{ organizationId, facilityId, role }` into `req.tenant`, filtering `status = 'active'`. So the role substrate and its server-side resolution are already in place — TEN-010 adds enforcement, invites, and UI on top of it, not the role column itself.
- **The JWT `user_role` claim is stale and points at the wrong axis.** `custom_access_token_hook` (`supabase/migrations/00001_...`) injects `public.users.role` — the **deprecated** `user_role` enum (`technician | supervisor | quality_lead | facility_lead`, an operational/seniority axis superseded by `organization_members.role` per ADR-005, not yet dropped). Mobile's `useUserRole()` (`artifacts/farmeasy/hooks/useUserRole.ts`) reads this stale claim. TEN-010 repoints the hook to the org role and retires the deprecated claim's readers.
- **No invitations table exists.** Only a `"team_invited"` string appears — a readiness-checklist *event key* (`facility_readiness_events`), unrelated to real invites. The invitations table is net-new.
- **No app-level email infrastructure exists.** No `nodemailer`/ESP/mailer module anywhere in `artifacts/api-server` or `lib`. The only email channel in the stack is Supabase Auth's own SMTP (for its verification/recovery emails), not configured for production. TEN-010 introduces a `lib/email` module over **Resend** for production invite delivery.
- **The web dashboard reads no role today.** `admin-dashboard` has zero role-awareness (grep-confirmed); `AuthGate` signs a user in and renders the app with no post-sign-in role gate. Nothing rejects a technician on web today. TEN-010 adds both the server-side 403 (the control) and the web technician-denied state (AUTH-003 screen).
- **`GET /users/me/settings` already establishes a `/me` route pattern** (`routes/userSettings.ts`) — a natural sibling for exposing the caller's resolved role/membership to the client where the JWT claim isn't sufficient.
- **`app.test.ts` (TEN-008/Task 12.5) exercises the real `app.ts` mount stack with genuine Supabase JWTs** — the right harness for asserting role-enforcement 403s end-to-end, not just per-router.

## 2. Design decisions

**Invite delivery: custom `invitations` table + Resend (production send) + Mailosaur (test/verification layer).** Our own table owns the full invite semantics the PRD ACs require (tokenized, single-use, 14-day expiry, revocable, org+role mapping) — Supabase's native invite doesn't fit revoke / custom-expiry / one-org-per-user cleanly. A new `lib/email` module sends the invite over Resend in production (API-key secret, per-env config). In dev/CI the mailer points at a **Mailosaur** server so tests capture the invite email, assert the token link, verify single-use + expiry + revoked-link failure, and run spam/deliverability analysis. **Supabase's mailer never fires in the invite flow** — acceptance creates the Supabase user via the admin API with the email pre-confirmed (`admin.createUser({ email_confirm: true })`), which sends no email (the Resend invite is the verification).

**Role authority: `organization_members.role` is the single source of truth; repoint the JWT hook to it and retire the stale claim.** Server-side enforcement via `req.tenant.role` is the actual control (PRD: "hiding UI is not the control"). `custom_access_token_hook` is repointed to inject the org role (`owner | admin | technician`) so clients read the correct role directly; mobile's `useUserRole()`/`isSupervisorOrLead` legacy readers of the deprecated operational role are audited and retired. This collapses the two role axes to one, matching ADR-005's expand-then-contract intent.

**Server-side enforcement is a per-router middleware, not UI hiding.** A `requireRole(...)` / `rejectTechnician` middleware on web-only API surfaces returns **403 + a stable error code** for a technician session regardless of client. UI visibility (hiding Settings → Team from technicians, showing the AUTH-003 denied screen) is a UX layer on top, never the security boundary.

**Org-level roles only — per-facility membership stays out.** TEN-010 is org-wide roles (owner/admin/technician); every active member still sees all of their org's facilities (Q24 default, carried from TEN-008). Per-facility membership assignment is a future RBAC initiative's scope, explicitly not here.

**Owner is creator-only, non-assignable and non-transferable in v1.** Invite roles offered are `admin | technician` only; `PATCH /members/:id/role` never sets or clears `owner`; the owner cannot be removed or demoted. (PRD: "owner role is not assignable or transferable in v1.")

## 3. Architecture

`invitations` table (new): `id, organization_id (FK), email, role (admin|technician), token_hash, status (pending|accepted|revoked|expired), invited_by (user FK), expires_at, created_at, accepted_at`. The token is 32 random bytes, stored **hashed** (SHA-256) — the raw token exists only in the invite link's URL fragment, never at rest, never in logs.

`custom_access_token_hook` (migration): repointed to read `organization_members.role` (for the user's active membership) and inject it as the role claim, replacing the deprecated `public.users.role` read. Absent membership → no role claim (or a documented default), same fail-safe shape as today.

`requireRole` / `rejectTechnician` middleware (new, `middlewares/`): reads `req.tenant.role` (already resolved by `resolveTenantContext`) and 403s a technician (or any insufficient role) on web-only routers, with a stable error code. Mounted per-router in `app.ts`, following the same tiering discipline TEN-008/Task 12.5 established (a role gate is a short-circuiting middleware — mount-order rules apply).

Invite/member routers (new): `routes/invitations.ts` (create/list/revoke/accept) and member operations (`change role`, `remove`) — `POST /invitations`, `GET /invitations`, `DELETE /invitations/:id`, `POST /invitations/accept`, `PATCH /members/:userId/role`, `DELETE /members/:userId`. Create/list/revoke/member-ops require owner|admin server-side; accept is token-authenticated (no session role required — the invitee may not be a member yet).

`lib/email` (new): a thin mailer with a Resend transport (production) and a Mailosaur/SMTP transport (test/dev), selected per-env. One `sendInvite(...)` entry point; the invite template lives here.

Frontend: web `admin-dashboard` gets a **Team** section in Settings (owner/admin only — hidden for technicians *and* server-enforced) and a technician-denied post-sign-in state in `AuthGate` (reads the repointed role claim → renders the "The dashboard is for admins — open the FarmSmart mobile app" AUTH-003 screen instead of the app). An `/accept-invite` route handles the token accept flow (new user sets a password / OAuth; existing user just joins). Mobile `farmeasy`: `useUserRole()` repointed to the org-role claim; technician sign-in unchanged.

## 4. Components

**Backend:**
- `lib/db` schema + migration — `invitations` table.
- `supabase/migrations/*` — repoint `custom_access_token_hook` to the org role.
- `middlewares/requireRole.ts` — role-gate middleware (403 + stable code).
- `routes/invitations.ts` — invite create/list/revoke/accept.
- `routes/members.ts` (or extend an existing router) — change-role, remove-member.
- `lib/email/` — Resend (prod) + Mailosaur/SMTP (test) mailer + invite template.
- `app.ts` — mount the new routers with `requireRole` where web-only, per the established tier rules.

**Frontend (web `admin-dashboard`):**
- `pages/settings/team/` — Team section: member list, pending invites, invite form (email + admin|technician), revoke, change-role, remove; owner/admin-gated.
- `pages/accept-invite/` — token accept flow (new/existing user).
- `App.tsx` `AuthGate` — technician-denied state (AUTH-003 screen) reading the repointed role claim.
- `lib/api-client-react` — regenerated hooks for the new endpoints (`openapi.yaml` additions).

**Frontend (mobile `farmeasy`):**
- `hooks/useUserRole.ts` — repoint to the org-role claim; retire `isSupervisorOrLead` legacy readers (audit call sites).

## 5. Data flow

**Invite:** owner/admin in Settings → Team submits `{email, role}` → `POST /invitations` validates caller is active owner/admin + email is not already an active member of any org → inserts a `pending` row (`expires_at = now + 14d`, `token_hash`) → `lib/email.sendInvite` sends via Resend, link `https://<dashboard>/accept-invite#token=<raw>` (token in **fragment**) → the row shows under Pending invites.

**Accept (new user):** click → `/accept-invite` reads the fragment → `POST /invitations/accept {token, password|oauth}` → server hashes the token, finds the `pending`, not-expired, not-revoked row → `admin.createUser({ email, password, email_confirm: true })` (no Supabase email) → inserts `organization_members {org, user, role, active}` → marks invite `accepted` (atomic, guards double-accept) → signs the user in. **Existing user (no org):** identical minus user creation. **Already in another org:** 400 "already belongs to an organization," invite stays `pending`.

**Role divergence at accept:** admin → dashboard. Technician → membership created, accept page detects `role = technician` → "open the FarmSmart mobile app" directing state (they never reach the dashboard; later web sign-in → AUTH-003 + server 403).

**Member ops:** change role (`PATCH /members/:userId/role` — admin↔technician only, never owner) / remove (`DELETE /members/:userId` → `status = 'removed'`; `resolveTenantContext`'s `status = 'active'` filter drops them the very next request; historical rows keep `user_id` for attribution).

## 6. Error handling

- **Role enforcement is server-side, uniform, and stable-coded:** technician (or insufficient role) on a web-only API → **403 `ROLE_FORBIDDEN`** regardless of client. UI hiding is never the control.
- **Tokens:** random 32-byte, SHA-256 **hashed** at rest; single-use (accept flips status atomically via `UPDATE ... WHERE status = 'pending'`, closing the double-accept race); 14-day expiry checked at accept; revoked/expired/reused → a **uniform** safe failure + re-request copy (no token-state enumeration).
- **One-org-per-user** enforced at invite-create and at accept; `organization_members_user_id_uniq` is the last-resort DB guard.
- **Authorization scoping:** every invite/member op requires the caller to be an active owner/admin of the *same* org as the target; cross-org manipulation → 403. Owner is never a valid invite role or a `PATCH`/`DELETE` member target.
- **Removed-member resolution ends within one request cycle** (the `status='active'` filter); the removed member's next request resolves no tenant → 403.
- **No token in query strings or logs;** the Resend API key is a per-env secret; the invite email carries the token only in the URL fragment.

## 7. Testing

- **Invite lifecycle (Mailosaur):** create invite → capture the email in a Mailosaur server → extract the token link → accept succeeds once → second accept fails (single-use) → expired-token accept fails → revoked-invite link fails → spam/deliverability check on the invite template.
- **Role enforcement (extend `app.test.ts` + `cross-tenant.test.ts`):** a technician JWT hitting a web-only API → 403 `ROLE_FORBIDDEN` through the **real** `app.ts` stack; admin → 200; cross-org invite/member op → 403; the isolation suite gains role-boundary cases.
- **Accept paths:** new user (creates auth user + membership, no Supabase email fired), existing user (membership only), already-in-another-org (400), technician-accept → directing state.
- **JWT repoint:** the hook now emits the org role; a DB/pgTAP check on `custom_access_token_hook`; mobile `useUserRole` reads the new claim; audit that no consumer still depends on the retired operational-role values.
- **Removal:** removed member's next request resolves no tenant (403); historical rows retained and still attributed.

## 8. Explicitly not in this document

- **TEN-012** (public sign-up "Create an account") — the sign-up surface + verification interstitial. Invite acceptance (this doc) is a *distinct* join path, never a sign-up variant.
- **TEN-013** (demo mode / post-sign-up fork).
- **TEN-009** (org rollup stubs).
- **TEN-014** (mobile entry policy — removing the mobile sign-up screen). TEN-010 only touches mobile insofar as the technician role reads the repointed claim and technician sign-in continues to work; removing mobile account-creation is TEN-014's scope.
- **Per-facility membership assignment** — org-level roles only here; per-facility scoping is a future RBAC initiative.
- **Owner transfer / multi-owner** — owner is creator-only, non-transferable in v1.
- **AUTH-002 (password reset), AUTH-003 (login redesign itself), AUTH-004 (telemetry)** — the AUTH-003 *technician-denied state* is consumed here, but the login redesign ships via the Remediation PRD, not this doc.

## 9. Risks and gaps

- **The JWT-hook repoint is the highest-risk single piece** — it changes the claim every authenticated client reads. A wrong hook can lock users out or hand the wrong role. Needs the same empirical, real-`app.ts`, real-JWT verification discipline TEN-008/Task 12.5 established, plus an audit that no client still depends on the retired operational-role values (`supervisor | quality_lead | facility_lead`).
- **Role enforcement is a new security surface** (PRD-flagged): invite tokens + server-side 403s. Getting the 403 in the middleware (not the UI) is the whole point — a technician with a token and `curl` must never read admin data. The isolation suite must carry role-boundary cases, not just org-boundary ones.
- **Email delivery is new production infrastructure** — a Resend account, a verified sending domain, an API-key secret, and per-env transport selection. Undelivered invites are a silent dead-end; the Mailosaur test layer verifies the *content and link*, but production deliverability (SPF/DKIM/domain reputation) is an operational task beyond the test harness.
- **The one-org-per-user invariant now has three enforcement points** (invite-create, accept, DB unique index) — they must agree; a gap between them (e.g. an invite created for an email that joins another org before accepting) resolves safely to the accept-time 400 + the DB guard, but the flow must be traced end-to-end.
- **`app.ts` mount ordering** — the new `requireRole` gates are short-circuiting middleware; they must respect the tier discipline from TEN-008/Task 12.5 (a role gate mounted ahead of an unrelated router would intercept it), and `app.test.ts` must cover the new gates.
- **No production traffic at real multi-member scale yet** — every org today is single-member (the creator/owner). This design is unverified against real invite/accept/removal churn until a second member exists (staging test orgs, same discipline as MT-M1/TEN-008).
