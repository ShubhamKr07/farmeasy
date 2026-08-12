-- TEN-011: server-side signup enforcement.
--
-- Public self-signup (browser `supabase.auth.signUp`, including Google OAuth
-- new-users via `signInWithOAuth`) bypasses the api-server entirely, so
-- nothing server-side enforced off/allowlist -- only GoTrue's native
-- `enable_signup=false` truly enforced `off`, and `allowlist` had NO native
-- enforcement at all. This migration closes that gap with a GoTrue
-- `before_user_created` Postgres hook that reads `public.signup_config`
-- (0034_signup_config.sql, TEN-011 Task 1) -- the SAME row `getSignupMode()`
-- (app) reads -- so the availability UI and real enforcement can never
-- drift (Option A, the locked design; see
-- docs/superpowers/specs/2026-08-12-ten011-signup-enforcement-design.md).
--
-- Event shape (CONFIRMED empirically against real GoTrue via a scratch
-- `before_user_created` hook + a live `/auth/v1/signup` call, not just
-- docs -- the email lives at `event->'user'->>'email'`; the full observed
-- event shape:
--   {"user": {"id": ..., "email": ..., "aud": ..., "role": ..., ...},
--    "metadata": {"name": "before-user-created", "time": ..., ...}}
--
-- Rejection contract (also confirmed live: a rejecting hook produced a real
-- HTTP 403 from POST /auth/v1/signup with the hook's own `message` surfaced
-- verbatim in the response body): return `{}` to allow, or
-- `{"error": {"http_code": <int>, "message": "..."}}` to reject.
--
-- Invited users are NOT specially handled here and don't need to be: they
-- are created via `admin.auth.admin.createUser()` (service_role), which
-- (also confirmed live: a POST /auth/v1/admin/users call succeeded with 200
-- while this exact hook was rejecting every /auth/v1/signup call) never
-- invokes `before_user_created` at all. No invitation check belongs in this
-- function.
--
-- Registration mirrors custom_access_token_hook (00015): SECURITY DEFINER,
-- `set search_path = ''` (fully-qualified references only -- avoids the
-- search-path-injection class of bug), execute granted only to
-- supabase_auth_admin (revoked from anon/authenticated/public), and an
-- explicit `grant select` on the tables the hook reads -- SECURITY DEFINER
-- still needs this independent of RLS (the 00001/00015 lesson: omitting it
-- 500s every call the grantless role makes).
--
-- Rollback:
--   revoke select on public.signup_config, public.signup_allowlist from supabase_auth_admin;
--   revoke execute on function public.before_user_created_hook(jsonb) from supabase_auth_admin;
--   drop function public.before_user_created_hook(jsonb);
--   drop policy "backend reads signup_config" on public.signup_config;
--   alter table public.signup_config disable row level security;
-- ...and disable [auth.hook.before_user_created] in config.toml (or set
-- enabled = false) -- see the plan's rollback note for the one-line disable.

create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_email text := lower(trim(coalesce(event->'user'->>'email', '')));
begin
  select mode into v_mode from public.signup_config where id = 1;

  if v_mode = 'public' then
    return '{}'::jsonb;
  elsif v_mode = 'allowlist' then
    if exists (select 1 from public.signup_allowlist where lower(email) = v_email) then
      return '{}'::jsonb;
    end if;
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Sign-ups are limited; your email is not on the allowlist.'
    ));
  else
    -- 'off' or NULL/unknown mode -- fail-closed: reject.
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Sign-ups are currently closed.'
    ));
  end if;
end;
$$;

grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.before_user_created_hook(jsonb) from authenticated, anon, public;

-- supabase_auth_admin needs table SELECT independent of SECURITY DEFINER
-- (same lesson as 00001's public.users grant / 00015's organization_members
-- grant -- omitting this 500s every sign-up attempt once the hook runs).
grant select on public.signup_config, public.signup_allowlist to supabase_auth_admin;

-- signup_config is a NEW public table -> it MUST get RLS (the #4 invariant
-- every public table added since MT-M2's remediation batches must satisfy;
-- see 00017/00020-00024 for the same pattern). Backend-only current_user
-- policy, matching signup_allowlist's own model (00017): only SELECT today
-- -- getSignupMode() is the only app-side reader; no route updates the mode
-- yet (that's a future admin-tooling task, out of scope for TEN-011 per the
-- design's YAGNI section). supabase_auth_admin's read comes from the
-- explicit grant above, not from an RLS policy: the hook function runs
-- SECURITY DEFINER, so its row-security context is the function owner
-- (postgres, a superuser in every environment this ships to -- local CLI,
-- staging, and production Supabase, all bypass RLS for superuser/owner
-- roles), the same precedent custom_access_token_hook already relies on to
-- read organization_members without an explicit supabase_auth_admin RLS
-- policy there.
alter table public.signup_config enable row level security;

create policy "backend reads signup_config" on public.signup_config
  for select using (current_user = 'farmsmart_app');
