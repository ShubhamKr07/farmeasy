-- pgTAP assertion for 00018_organizations_backend_delete_policy.sql: the
-- backend farmsmart_app role must have a DELETE policy on public.organizations
-- so the TEN-012 unverified-account purge can delete a data-less provisioned
-- org under the real non-BYPASSRLS role (the disposable CI DB is BYPASSRLS and
-- masks its absence). Structural check (the farmsmart_app role does not exist
-- in the fresh CI disposable DB, so no SET ROLE functional test).
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(2);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organizations'
       AND cmd = 'DELETE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1,
  'organizations has exactly one farmsmart_app-scoped DELETE policy'
);

-- RLS is (still) enabled on organizations — the policy is meaningless otherwise.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass),
  'row-level security is enabled on public.organizations'
);

SELECT * FROM finish();
ROLLBACK;
