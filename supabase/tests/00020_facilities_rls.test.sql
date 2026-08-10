-- pgTAP assertions for 00020_facilities_rls.sql: public.facilities must have
-- row level security enabled with exactly 3 farmsmart_app-scoped backend
-- policies (SELECT, INSERT, DELETE). facilities shipped with NO row level
-- security through 00019 (see 00019_demo_fork_rls.sql's note) -- it is read
-- in bootstrap contexts before app.org_id exists (GET /facilities, wizard
-- org-resolution, demo getOwnerOrg, the unverified-purge sweep), so the
-- backstop is current_user = 'farmsmart_app' (the 00010/00012/00016 model),
-- NOT a GUC-scoped policy. No UPDATE policy -- nothing updates facilities
-- today.
--
-- STRUCTURAL assertions (RLS flag + policy presence + cmd + predicate), not a
-- live SET ROLE functional check: the farmsmart_app role does not exist in
-- the fresh, empty disposable-Supabase CI database (it is provisioned only in
-- staging/production and in the local non-BYPASSRLS RLS-proof harness), so a
-- role-switching test would fail in CI -- same convention as 00016-00019. The
-- functional proof -- that these policies actually admit every existing
-- facilities SELECT/INSERT/DELETE route path under the real non-BYPASSRLS
-- farmsmart_app role, with zero regression -- is carried by the api-server
-- facilities/wizard/demo/metrics/growthProfiles/purge suites run against that
-- role via the disposable stack.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(5);

-- 1. RLS is enabled on facilities -- the policies are meaningless otherwise.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.facilities'::regclass),
  'row-level security is enabled on public.facilities'
);

-- 2. Exactly 3 policies exist on facilities in total (SELECT + INSERT +
--    DELETE, no UPDATE).
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'facilities'),
  3,
  'facilities has exactly 3 policies'
);

-- 3. Exactly one farmsmart_app-scoped SELECT policy.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'facilities'
       AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'facilities has exactly one farmsmart_app-scoped SELECT policy'
);

-- 4. Exactly one farmsmart_app-scoped INSERT policy.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'facilities'
       AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'facilities has exactly one farmsmart_app-scoped INSERT policy'
);

-- 5. Exactly one farmsmart_app-scoped DELETE policy.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'facilities'
       AND cmd = 'DELETE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'facilities has exactly one farmsmart_app-scoped DELETE policy'
);

SELECT * FROM finish();
ROLLBACK;
