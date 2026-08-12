# TEN-011 — Server-side signup enforcement — Design

**Status:** design, awaiting review. Branch `mt-m2-ten011-signup-enforcement-design`.
**Relates to:** task #2; **prerequisite before flipping the public sign-up flag on** (TEN-012 shipped `SIGNUP_MODE` UI-gated + default off; this makes off/allowlist actually enforced server-side).

## Problem
`SIGNUP_MODE` (app env) gates only the UI. Real account creation happens two ways:
- **Public self-signup:** the browser calls `supabase.auth.signUp` (anon key) directly, and Google OAuth new-users via `signInWithOAuth` — **both bypass the api-server entirely.** Nothing server-side enforces off/allowlist. `off` is only truly enforced by GoTrue's native `enable_signup=false`; `allowlist` has NO native enforcement.
- **Invited users:** `POST /invitations/accept` creates the account via `admin.auth.admin.createUser()` (service_role) — which **bypasses the `before_user_created` hook** (admin creates don't trigger it). Verified.

So the enforcement point for public signup is a GoTrue **`before_user_created` auth hook** (a Postgres function GoTrue calls before creating any non-admin user). The `config.toml` stub for it already exists (commented, `[auth.hook.before_user_created]`).

## Decision (2026-08-12): Option A — DB signup-config as single source of truth + the hook

A small **`signup_config`** table holds the mode; **both the app and the hook read it** → the availability UI and the actual enforcement can never drift (the failure mode of splitting mode across app-env + GoTrue `enable_signup` + a hook signal). The hook enforces **all three modes** from that row; GoTrue `enable_signup` stays `true`. (Rationale: the impact analysis — one authoritative row, instant/atomic mode switch with no redeploy, no UI↔enforcement drift.)

## Components

### 1. `signup_config` singleton table
- `signup_config(id, mode text check (mode in ('off','allowlist','public')), updated_at)` — exactly one row (enforce via a `id = true`-style singleton or a `CHECK`/unique). Seed the initial `mode` from the current `SIGNUP_MODE` env (or default `'off'`) in the migration.
- **Single source of truth.** The app's `getSignupMode()` (lib/signupMode.ts) is refactored to read this row (env may seed it / act as a documented fallback, but the DB is authoritative). `GET /auth/signup-availability` reads the same → UI stays consistent with enforcement.

### 2. `before_user_created` Postgres hook
- `create function public.before_user_created_hook(event jsonb) returns jsonb`, **SECURITY DEFINER**, mirroring `custom_access_token_hook`'s registration (`00015`): `grant execute to supabase_auth_admin`; `revoke execute from authenticated, anon, public`; `grant select on public.signup_config, public.signup_allowlist to supabase_auth_admin` (SECURITY DEFINER still needs explicit SELECT grants — the 00001/00015 lesson).
- **Logic:** read `signup_config.mode`.
  - `off` → return a rejection (reject all self-signups).
  - `allowlist` → extract the email from `event` (lowercased/trimmed to match how `signup_allowlist` stores it, per `invitations`' convention); if not in `signup_allowlist`, reject; else allow.
  - `public` → allow.
- **Rejection contract:** confirm the exact Supabase `before_user_created` return shape (return `{"error": {"http_code": 403, "message": "…"}}` vs raising) — pin in the plan against Supabase's current hook docs. Return the pass-through event on allow.
- Register in `config.toml`: `[auth.hook.before_user_created]` `enabled = true`, `uri = "pg-functions://postgres/public/before_user_created_hook"`.

### 3. Invited-user & OAuth behavior (no special-casing needed)
- **Invited users are automatically exempt** — they never hit the hook (admin.createUser path). No invitation check in the hook.
- **OAuth new-users DO hit the hook** — in `allowlist` mode, a non-allowlisted Google signup is correctly rejected (email checked regardless of provider). Intended; document it.

### 4. Optional belt-and-suspenders for `off`
May also set GoTrue `enable_signup=false` when mode=off (GoTrue blocks before the hook even runs). Keep the DB row authoritative; treat this as defense-in-depth, not the mechanism — else we reintroduce the drift Option A avoids.

## Testing
- **Hook unit (pgTAP + direct call):** call `public.before_user_created_hook(<synthetic event jsonb>)` with `signup_config.mode` set to each of off/allowlist/public × (allowlisted / not) and assert allow vs the rejection shape. Structural pgTAP for the function existing + grants (supabase_auth_admin execute, revoked from anon/authenticated).
- **Integration:** in `off` → a public `auth.signUp` is rejected; in `allowlist` → non-allowlisted rejected, allowlisted allowed; in `public` → allowed. Invited-via-admin always succeeds regardless of mode (proves the bypass). Where the disposable stack can't run real GoTrue signup, prove the hook function directly + assert the mode-config read.
- Confirm `GET /auth/signup-availability` and the hook read the same `signup_config` (no drift).

## Rollout
- Ship the migration (table + hook + grants) + `config.toml` hook enable + the app `getSignupMode()` refactor. Staging first: set `signup_config.mode`, exercise each mode, confirm enforcement + UI agree. Then prod.
- After this lands, flipping the public sign-up flag = updating `signup_config.mode` (instant, no redeploy) — this task is the safety prerequisite for that flip.

## Open items for the plan
- Exact `before_user_created` return/reject contract (Supabase docs) + the `event` jsonb shape (where the email lives).
- Full `SIGNUP_MODE` env → `signup_config` migration vs keep env as seed/fallback (recommend: DB authoritative, env seeds on first migration, then deprecate).
- Coexistence with the existing `custom_access_token_hook` (two auth hooks registered — both are independent pg-function hooks; confirm no conflict).
- The three tables' current RLS: `signup_allowlist` + `signup_config` — `signup_allowlist` got RLS in `00017`; `signup_config` is new → give it RLS (backend `current_user` policy + the supabase_auth_admin SELECT the hook needs).

## Out of scope (YAGNI)
- CAPTCHA / bot mitigation / signup rate-limiting.
- Changing the invite flow or the availability-UI behavior beyond reading the DB config.
- The actual flip to public/allowlist (that's the downstream flag change this unblocks).
