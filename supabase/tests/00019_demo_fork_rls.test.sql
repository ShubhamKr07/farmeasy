-- pgTAP assertions for 00019_demo_fork_rls.sql: the backend farmsmart_app
-- role must have an UPDATE policy on public.organizations so
-- POST /api/demo/provision and POST /api/demo/graduate can flip
-- organizations.is_demo under the real non-BYPASSRLS role (organizations
-- had backend SELECT/INSERT (00010) and DELETE (00018) policies, but no
-- UPDATE, until now).
--
-- These are STRUCTURAL assertions (RLS flag + policy presence + predicate),
-- not a live SET ROLE functional check: the farmsmart_app role does not
-- exist in the fresh, empty disposable-Supabase CI database (it is
-- provisioned only in staging/production and in the local non-BYPASSRLS
-- RLS-proof harness), so a role-switching test would fail in CI -- same
-- convention as 00016/00017/00018. The functional proof -- that this policy
-- actually admits the demo-provision/graduate is_demo flip for the caller's
-- own org and denies it cross-tenant (0 rows, not an error) under a real
-- non-BYPASSRLS farmsmart_app role -- is carried by the api-server route/
-- isolation suites that call POST /api/demo/provision and
-- POST /api/demo/graduate against that role.
--
-- NOTE: this migration does NOT include a facilities DELETE policy.
-- public.facilities has never had row level security enabled in this
-- migration history and enabling it is out of scope for TEN-013 (its own
-- tracked remediation) -- see 00019_demo_fork_rls.sql's top comment for the
-- full reasoning and the graduate-delete trust-model decision. Not asserted
-- here.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(3);

-- 1. RLS is (still) enabled on organizations -- the policy is meaningless
--    otherwise.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass),
  'row-level security is enabled on public.organizations'
);

-- 2. Exactly one farmsmart_app-scoped UPDATE policy exists on organizations.
--    (qual covers USING; with_check covers WITH CHECK -- both are set here,
--     so either alone would already match; COALESCE for consistency with
--     the sibling 00016/00017/00018 tests.)
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organizations'
       AND cmd = 'UPDATE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'organizations has exactly one farmsmart_app-scoped UPDATE policy'
);

-- 3. That policy is additionally scoped to app.org_id (defense-in-depth: the
--    demo endpoints run this UPDATE inside a transaction that sets
--    app.org_id before the write, unlike 00018's DELETE policy which backs
--    a scheduled sweep that never has app.org_id set -- see 00019's
--    migration comment).
SELECT ok(
  (SELECT coalesce(qual, with_check) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organizations' AND cmd = 'UPDATE')
    LIKE '%app.org_id%',
  'organizations UPDATE policy is additionally scoped to the app.org_id GUC'
);

SELECT * FROM finish();
ROLLBACK;
