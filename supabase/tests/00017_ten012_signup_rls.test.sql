-- pgTAP assertions for 00017_ten012_signup_rls_backend_policies.sql: the
-- three TEN-012 sign-up tables (signup_allowlist, access_requests,
-- account_purge_audit) must have row-level security ENABLED and carry
-- current_user='farmsmart_app' backend policies for exactly the verbs each
-- flow uses -- the same defense-in-depth model invitations gets from 00016
-- and organization_members gets from 00011/00012/00014. Before 00017 these
-- tables (added in TEN-012 Task 1) had NO RLS at all, and they hold PII
-- (waitlist emails, farm names, purge-audit emails).
--
-- These are STRUCTURAL assertions (RLS flag + policy count + predicate),
-- not a live SET ROLE functional check: the farmsmart_app role does not
-- exist in the fresh, empty disposable-Supabase CI database (it is
-- provisioned only in staging/production and in the local non-BYPASSRLS
-- RLS-proof harness), so a role-switching test would fail in CI.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(9);

-- signup_allowlist: SELECT + INSERT + DELETE (3 policies).
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_allowlist'::regclass),
  'row-level security is enabled on public.signup_allowlist'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'signup_allowlist'),
  3,
  'public.signup_allowlist has exactly 3 policies (select/insert/delete)'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'signup_allowlist'
       AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  3,
  'all 3 signup_allowlist policies are scoped to current_user = farmsmart_app'
);

-- access_requests: SELECT + INSERT + UPDATE (3 policies).
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.access_requests'::regclass),
  'row-level security is enabled on public.access_requests'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'access_requests'),
  3,
  'public.access_requests has exactly 3 policies (select/insert/update)'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'access_requests'
       AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  3,
  'all 3 access_requests policies are scoped to current_user = farmsmart_app'
);

-- account_purge_audit: SELECT + INSERT (2 policies).
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_purge_audit'::regclass),
  'row-level security is enabled on public.account_purge_audit'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'account_purge_audit'),
  2,
  'public.account_purge_audit has exactly 2 policies (select/insert)'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'account_purge_audit'
       AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  2,
  'all 2 account_purge_audit policies are scoped to current_user = farmsmart_app'
);

SELECT * FROM finish();
ROLLBACK;
