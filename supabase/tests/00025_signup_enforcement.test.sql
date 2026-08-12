-- pgTAP assertions for 00025_signup_enforcement.sql (TEN-011): the
-- before_user_created Postgres hook that enforces public.signup_config's
-- mode (off/allowlist/public) server-side, and signup_config's own RLS.
--
-- STRUCTURAL assertions: the function exists, is SECURITY DEFINER, execute
-- is granted to supabase_auth_admin and revoked from anon/authenticated;
-- signup_config has RLS enabled with exactly the one backend SELECT policy.
-- (Same caveat as 00017: the disposable CI DB is a fresh, empty database
-- where farmsmart_app doesn't exist, so these are structural checks, not a
-- live SET ROLE functional proof -- the same model 00015/00017 use.)
--
-- BEHAVIORAL assertions: call public.before_user_created_hook(<synthetic
-- event>) directly with signup_config.mode set to each of off/allowlist/
-- public x (allowlisted email present/absent) and assert the `{}` (allow)
-- vs `{"error": {...}}` (reject) shape -- the exact contract GoTrue expects
-- from a before_user_created Postgres hook (confirmed live against real
-- GoTrue during this migration's build -- see 00025's own header).
--
-- Run inside a transaction that is always rolled back, so these assertions
-- leave no side effects on the database. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
BEGIN;

SELECT plan(14);

-- ──────────────────────────────────────────────────────────────────────────
-- Structural: the function.
-- ──────────────────────────────────────────────────────────────────────────
SELECT has_function(
  'public',
  'before_user_created_hook',
  ARRAY['jsonb']::text[],
  'public.before_user_created_hook(jsonb) function exists'
);

SELECT is(
  (SELECT prosecdef FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = 'before_user_created_hook'),
  true,
  'before_user_created_hook is SECURITY DEFINER'
);

SELECT ok(
  has_function_privilege('supabase_auth_admin', 'public.before_user_created_hook(jsonb)', 'EXECUTE'),
  'supabase_auth_admin can EXECUTE before_user_created_hook'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.before_user_created_hook(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE before_user_created_hook'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.before_user_created_hook(jsonb)', 'EXECUTE'),
  'authenticated cannot EXECUTE before_user_created_hook'
);

-- ──────────────────────────────────────────────────────────────────────────
-- Structural: signup_config RLS (new public table -> must have RLS).
-- ──────────────────────────────────────────────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_config'::regclass),
  'row-level security is enabled on public.signup_config'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'signup_config'),
  1,
  'public.signup_config has exactly 1 policy (backend select)'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'signup_config'
       AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'the signup_config policy is scoped to current_user = farmsmart_app'
);

-- The seeded singleton row (0034_signup_config.sql).
SELECT is(
  (SELECT mode FROM public.signup_config WHERE id = 1),
  'off',
  'signup_config seeds the singleton row with mode=off'
);

-- ──────────────────────────────────────────────────────────────────────────
-- Behavioral: the hook itself, across all three modes.
-- Seed one allowlisted email for the allowlist-mode cases.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.signup_allowlist (email) VALUES ('allowed@example.com');

-- mode = off -> reject, regardless of email.
UPDATE public.signup_config SET mode = 'off' WHERE id = 1;
SELECT is(
  public.before_user_created_hook(
    jsonb_build_object('user', jsonb_build_object('email', 'anyone@example.com'))
  ),
  jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Sign-ups are currently closed.'
  )),
  'mode=off rejects sign-up (fail-closed)'
);

-- mode = allowlist, email present -> allow.
UPDATE public.signup_config SET mode = 'allowlist' WHERE id = 1;
SELECT is(
  public.before_user_created_hook(
    jsonb_build_object('user', jsonb_build_object('email', 'allowed@example.com'))
  ),
  '{}'::jsonb,
  'mode=allowlist allows an allowlisted email'
);

-- mode = allowlist, email present with different case/whitespace in the
-- event -> still allowed (normalized lower/trim on both sides).
SELECT is(
  public.before_user_created_hook(
    jsonb_build_object('user', jsonb_build_object('email', '  Allowed@Example.com  '))
  ),
  '{}'::jsonb,
  'mode=allowlist allows an allowlisted email regardless of case/whitespace'
);

-- mode = allowlist, email absent -> reject.
SELECT is(
  public.before_user_created_hook(
    jsonb_build_object('user', jsonb_build_object('email', 'not-allowed@example.com'))
  ),
  jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Sign-ups are limited; your email is not on the allowlist.'
  )),
  'mode=allowlist rejects a non-allowlisted email'
);

-- mode = public -> allow, regardless of email.
UPDATE public.signup_config SET mode = 'public' WHERE id = 1;
SELECT is(
  public.before_user_created_hook(
    jsonb_build_object('user', jsonb_build_object('email', 'anyone-else@example.com'))
  ),
  '{}'::jsonb,
  'mode=public allows any email'
);

SELECT * FROM finish();
ROLLBACK;
