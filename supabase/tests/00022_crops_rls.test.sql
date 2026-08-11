-- pgTAP assertions for 00022_crops_rls.sql: public.crops must have row
-- level security enabled with exactly 4 ROLE-AGNOSTIC app.org_id GUC
-- policies (select/insert/update/delete) -- no current_user clause, no TO
-- clause -- so that both farmsmart_app and the task-#5 farmsmart_recommender
-- role are scoped by the same policies once they set app.org_id. This is a
-- structural difference from Batches 1/2 (facilities, the 10 backend-
-- bootstrap tables), whose policies are current_user-scoped backstops; crops
-- must NOT follow that pattern (see 00022's own header + the design spec).
--
-- STRUCTURAL assertions (RLS flag + policy count/cmd/predicate), not a live
-- SET ROLE functional check: the farmsmart_app role does not exist in the
-- fresh, empty disposable-Supabase CI database -- same convention as
-- 00016-00021. The functional proof -- that org A sees system+own crops and
-- never org B's, and cannot mutate a system crop or org B's crop -- under
-- the real non-BYPASSRLS farmsmart_app role is carried by the api-server
-- crops route/isolation suite run against the disposable stack (this
-- batch's Task 3).
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(12);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.crops'::regclass),
  'row-level security is enabled on public.crops'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'),
  4, 'crops has exactly 4 policies'
);

-- SELECT policy: role-agnostic (no current_user), admits system crops
-- (organization_id IS NULL) OR the caller's own org.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND cmd = 'SELECT'
     AND coalesce(qual, with_check) LIKE '%app.org_id%'
     AND coalesce(qual, with_check) LIKE '%organization_id is null%'
     AND coalesce(qual, with_check) NOT LIKE '%current_user%'),
  1, 'crops has exactly one role-agnostic SELECT policy admitting system (organization_id IS NULL) or own-org rows'
);

-- INSERT policy: role-agnostic, own org only.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND cmd = 'INSERT'
     AND coalesce(qual, with_check) LIKE '%app.org_id%'
     AND coalesce(qual, with_check) NOT LIKE '%current_user%'),
  1, 'crops has exactly one role-agnostic INSERT policy scoped to app.org_id'
);

-- UPDATE policy: role-agnostic, own org only, both USING and WITH CHECK set.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND cmd = 'UPDATE'
     AND qual LIKE '%app.org_id%' AND with_check LIKE '%app.org_id%'
     AND qual NOT LIKE '%current_user%' AND with_check NOT LIKE '%current_user%'),
  1, 'crops has exactly one role-agnostic UPDATE policy scoped to app.org_id on both USING and WITH CHECK'
);

-- DELETE policy: role-agnostic, own org only.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND cmd = 'DELETE'
     AND coalesce(qual, with_check) LIKE '%app.org_id%'
     AND coalesce(qual, with_check) NOT LIKE '%current_user%'),
  1, 'crops has exactly one role-agnostic DELETE policy scoped to app.org_id'
);

-- No policy on crops carries a role restriction (`TO <role>`) or a
-- current_user clause -- the whole point of this batch's role-agnostic
-- model (task #5 compatibility). pg_policies.roles is {public} (no TO
-- clause) for every crops policy.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND roles <> ARRAY['public']::name[]),
  0, 'no crops policy restricts roles via a TO clause'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND (coalesce(qual, '') LIKE '%current_user%' OR coalesce(with_check, '') LIKE '%current_user%')),
  0, 'no crops policy references current_user'
);

-- Every policy predicate uses the NULLIF-guarded GUC cast idiom (00013),
-- not a bare current_setting(...)::int cast.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crops'
     AND coalesce(qual, with_check) LIKE '%nullif(current_setting(''app.org_id''%'),
  4, 'all 4 crops policies use the nullif(current_setting(...), '''')::int GUC-cast idiom'
);

-- crops.organization_id is nullable (system crops) and references
-- organizations with cascade delete.
SELECT ok(
  NOT (SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'public.crops'::regclass AND attname = 'organization_id'),
  'crops.organization_id is nullable (NULL = system crop)'
);

-- The old table-wide unique(name) is gone; per-org + partial system-name
-- unique indexes exist instead.
SELECT has_index('public', 'crops', 'crops_org_id_name_uniq', 'crops_org_id_name_uniq index exists');
SELECT has_index('public', 'crops', 'crops_system_name_uniq', 'crops_system_name_uniq index exists');

SELECT * FROM finish();
ROLLBACK;
