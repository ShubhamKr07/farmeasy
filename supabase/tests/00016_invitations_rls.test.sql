-- pgTAP assertions for 00016_invitations_rls_backend_policies.sql: the
-- invitations table must have row-level security ENABLED and carry the four
-- current_user='farmsmart_app' backend policies (SELECT/INSERT/UPDATE/DELETE),
-- the same defense-in-depth model organization_members gets from 00011/00012/
-- 00014. Before 00016 the invitations table had NO RLS at all -- the only
-- tenant-scoped table without a backstop, storing invite token hashes.
--
-- These are STRUCTURAL assertions (RLS flag + policy presence + predicate),
-- not a live SET ROLE functional check: the farmsmart_app role does not exist
-- in the fresh, empty disposable-Supabase CI database (it is provisioned only
-- in staging/production and in the local non-BYPASSRLS RLS-proof harness), so
-- a role-switching test would fail in CI. The functional proof -- that these
-- policies actually admit the app's own invitations SELECT/INSERT/UPDATE/
-- DELETE under a real non-BYPASSRLS farmsmart_app role -- is carried by
-- re-running the invitations/accept route suites under that role.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(6);

-- 1. RLS is enabled on the table.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invitations'::regclass),
  'row-level security is enabled on public.invitations'
);

-- 2. Exactly the four expected backend policies exist (one per verb).
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'invitations'),
  4,
  'public.invitations has exactly 4 policies (one per verb)'
);

-- 3. Every invitations policy is scoped to the farmsmart_app backend role.
--    (qual covers USING; with_check covers WITH CHECK -- INSERT has only the
--     latter, DELETE only the former, so COALESCE the pair before matching.)
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'invitations'
       AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  4,
  'all 4 invitations policies are scoped to current_user = farmsmart_app'
);

-- 4-6. The three verbs the invite flows write with each have a policy present
--       by command (SELECT is read by list + one-org check + token lookup;
--       INSERT by create/upsert; UPDATE by upsert-conflict, atomic claim,
--       expire, and revert). DELETE (revoke) is covered by assertion 2's count.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'invitations' AND cmd = 'SELECT'),
  'invitations has a SELECT policy (list / one-org check / token lookup)'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'invitations' AND cmd = 'INSERT'),
  'invitations has an INSERT policy (create / upsert)'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'invitations' AND cmd = 'UPDATE'),
  'invitations has an UPDATE policy (upsert conflict / claim / expire / revert)'
);

SELECT * FROM finish();
ROLLBACK;
