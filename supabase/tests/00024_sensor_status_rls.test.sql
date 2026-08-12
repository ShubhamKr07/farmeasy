-- pgTAP assertions for 00024_sensor_status_rls.sql: public.sensor_status
-- must have row level security enabled with exactly 3 ROLE-AGNOSTIC
-- app.facility_id GUC policies (select/insert/update) -- no current_user
-- clause, no TO clause -- matching 00007's/00022's idiom.
--
-- STRUCTURAL assertions (RLS flag + policy count/cmd/predicate), not a live
-- SET ROLE functional check: the farmsmart_app role does not exist in the
-- fresh, empty disposable-Supabase CI database -- same convention as
-- 00016-00022. The functional proof -- that org A's cycle write is never
-- visible when org B reads sensor_status, under the real non-BYPASSRLS
-- farmsmart_app role -- is carried by the api-server isolation test (this
-- batch's Task 4).
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(11);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sensor_status'::regclass),
  'row-level security is enabled on public.sensor_status'
);

SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'),
  3, 'sensor_status has exactly 3 policies'
);

-- SELECT policy: role-agnostic, own facility only.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND cmd = 'SELECT'
     AND coalesce(qual, with_check) LIKE '%app.facility_id%'
     AND coalesce(qual, with_check) NOT LIKE '%current_user%'),
  1, 'sensor_status has exactly one role-agnostic SELECT policy scoped to app.facility_id'
);

-- INSERT policy: role-agnostic, own facility only.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND cmd = 'INSERT'
     AND coalesce(qual, with_check) LIKE '%app.facility_id%'
     AND coalesce(qual, with_check) NOT LIKE '%current_user%'),
  1, 'sensor_status has exactly one role-agnostic INSERT policy scoped to app.facility_id'
);

-- UPDATE policy: role-agnostic, own facility only, both USING and WITH CHECK set.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND cmd = 'UPDATE'
     AND qual LIKE '%app.facility_id%' AND with_check LIKE '%app.facility_id%'
     AND qual NOT LIKE '%current_user%' AND with_check NOT LIKE '%current_user%'),
  1, 'sensor_status has exactly one role-agnostic UPDATE policy scoped to app.facility_id on both USING and WITH CHECK'
);

-- No DELETE policy -- neither call site deletes sensor_status rows.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND cmd = 'DELETE'),
  0, 'sensor_status has no DELETE policy (no call site deletes rows)'
);

-- No policy on sensor_status carries a role restriction (`TO <role>`) or a
-- current_user clause -- the whole point of this batch's role-agnostic
-- model. pg_policies.roles is {public} (no TO clause) for every policy.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND roles <> ARRAY['public']::name[]),
  0, 'no sensor_status policy restricts roles via a TO clause'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND (coalesce(qual, '') LIKE '%current_user%' OR coalesce(with_check, '') LIKE '%current_user%')),
  0, 'no sensor_status policy references current_user'
);

-- Every policy predicate uses the NULLIF-guarded GUC cast idiom (00013),
-- not a bare current_setting(...)::int cast.
--
-- ILIKE + '%'-bounded fragments, not an exact-cased/exact-spaced string:
-- ruleutils.c deparses NULLIF as the upper-cased SQL construct `NULLIF(...)`
-- (not the lowercase-as-written call syntax) and inserts its own
-- ::text/::integer casts around the arguments, so the source migration's
-- literal `nullif(current_setting('app.facility_id'` substring never
-- matches the normalized form verbatim even though the idiom is present.
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_status'
     AND coalesce(qual, with_check) ILIKE '%nullif%'
     AND coalesce(qual, with_check) ILIKE '%current_setting(%''app.facility_id''%'),
  3, 'all 3 sensor_status policies use the nullif(current_setting(...), '''')::int GUC-cast idiom'
);

-- sensor_status.facility_id is NOT NULL and unique (one row per facility).
SELECT ok(
  (SELECT attnotnull FROM pg_attribute
   WHERE attrelid = 'public.sensor_status'::regclass AND attname = 'facility_id'),
  'sensor_status.facility_id is NOT NULL'
);
SELECT has_index('public', 'sensor_status', 'sensor_status_facility_id_uniq', 'sensor_status_facility_id_uniq index exists');

SELECT * FROM finish();
ROLLBACK;
