-- pgTAP assertions for 00023_recommender_rls.sql: RLS on recommender_cache
-- and recommender_queries (both previously RLS-less), plus the added
-- farmsmart_recommender SELECT policy on bad_tray_entries (which previously
-- only admitted farmsmart_app, from 00021).
--
-- STRUCTURAL assertions only (RLS flag + policy count/cmd/predicate), not a
-- live SET ROLE functional check: farmsmart_recommender does not exist in
-- the disposable-CI database (same convention as 00016-00022). The
-- functional proof -- own-tenant grounding, no cross-tenant leakage, and
-- that recommender_cache/recommender_queries reads/writes actually work
-- under the real non-BYPASSRLS role -- is carried by the recommender's own
-- pytest suite + the api-server integration path + staging.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(13);

-- ── recommender_cache: SELECT, INSERT (2 policies), admits BOTH
--    farmsmart_recommender and farmsmart_app ─────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recommender_cache'::regclass),
  'row-level security is enabled on public.recommender_cache'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_cache'),
  2, 'recommender_cache has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_cache'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_recommender%'
     AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'recommender_cache has exactly one SELECT policy admitting both farmsmart_recommender and farmsmart_app'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_cache'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_recommender%'
     AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'recommender_cache has exactly one INSERT policy admitting both farmsmart_recommender and farmsmart_app'
);

-- ── recommender_queries: SELECT, INSERT (2 policies), farmsmart_recommender
--    only (per-user audit log; app-layer scopes by user_id) ─────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recommender_queries'::regclass),
  'row-level security is enabled on public.recommender_queries'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_queries'),
  2, 'recommender_queries has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_queries'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_recommender%'),
  1, 'recommender_queries has exactly one farmsmart_recommender-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recommender_queries'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_recommender%'),
  1, 'recommender_queries has exactly one farmsmart_recommender-scoped INSERT policy'
);

-- ── bad_tray_entries: now has BOTH a farmsmart_app AND a
--    farmsmart_recommender SELECT policy (3 policies total: farmsmart_app
--    SELECT + INSERT from 00021, plus this task's farmsmart_recommender
--    SELECT) ────────────────────────────────────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bad_tray_entries'::regclass),
  'row-level security remains enabled on public.bad_tray_entries'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'),
  3, 'bad_tray_entries has exactly 3 policies (00021''s app SELECT+INSERT, plus this task''s recommender SELECT)'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'bad_tray_entries retains its farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'bad_tray_entries retains its farmsmart_app-scoped INSERT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_recommender%'),
  1, 'bad_tray_entries has exactly one NEW farmsmart_recommender-scoped SELECT policy'
);

SELECT * FROM finish();
ROLLBACK;
