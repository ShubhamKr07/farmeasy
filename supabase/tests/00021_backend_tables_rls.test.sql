-- pgTAP assertions for 00021_backend_tables_rls.sql: the 10 batch-2 backend
-- tables (rooms, channels, racks, trays, sensor_readings, bad_tray_entries,
-- manual_checks, stock_movements, cycle_seed_lots, user_settings) must each
-- have row level security enabled with exactly the audited farmsmart_app-
-- scoped per-verb policies (no more, no fewer -- a missing-verb policy is a
-- silent 0-row denial under the real role; an extra unaudited-verb policy is
-- an unwarranted grant). See 00021's own header comment for the full
-- per-table verb audit and rationale (why stock_movements/cycle_seed_lots are
-- SELECT-only, why user_settings needs UPDATE for its onConflictDoUpdate
-- path, etc).
--
-- STRUCTURAL assertions (RLS flag + policy count/cmd/predicate), not a live
-- SET ROLE functional check: the farmsmart_app role does not exist in the
-- fresh, empty disposable-Supabase CI database (it is provisioned only in
-- staging/production and in the local non-BYPASSRLS RLS-proof harness), so a
-- role-switching test would fail in CI -- same convention as 00016-00020. The
-- functional proof -- that these policies actually admit every existing
-- route/lib SELECT/INSERT/UPDATE/DELETE path for these 10 tables under the
-- real non-BYPASSRLS farmsmart_app role, with zero regression -- is carried
-- by the full api-server suite run against that role via the disposable
-- stack.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(44);

-- ── rooms: SELECT, INSERT (2 policies) ──────────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rooms'::regclass),
  'row-level security is enabled on public.rooms'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rooms'),
  2, 'rooms has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rooms'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'rooms has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rooms'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'rooms has exactly one farmsmart_app-scoped INSERT policy'
);

-- ── channels: SELECT, INSERT, UPDATE, DELETE (4 policies) ──────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.channels'::regclass),
  'row-level security is enabled on public.channels'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'channels'),
  4, 'channels has exactly 4 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'channels'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'channels has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'channels'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'channels has exactly one farmsmart_app-scoped INSERT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'channels'
     AND cmd = 'UPDATE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'channels has exactly one farmsmart_app-scoped UPDATE policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'channels'
     AND cmd = 'DELETE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'channels has exactly one farmsmart_app-scoped DELETE policy'
);

-- ── racks: SELECT, INSERT, UPDATE, DELETE (4 policies) ──────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.racks'::regclass),
  'row-level security is enabled on public.racks'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'racks'),
  4, 'racks has exactly 4 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'racks'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'racks has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'racks'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'racks has exactly one farmsmart_app-scoped INSERT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'racks'
     AND cmd = 'UPDATE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'racks has exactly one farmsmart_app-scoped UPDATE policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'racks'
     AND cmd = 'DELETE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'racks has exactly one farmsmart_app-scoped DELETE policy'
);

-- ── trays: SELECT, INSERT, DELETE (3 policies) ──────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trays'::regclass),
  'row-level security is enabled on public.trays'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trays'),
  3, 'trays has exactly 3 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trays'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'trays has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trays'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'trays has exactly one farmsmart_app-scoped INSERT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trays'
     AND cmd = 'DELETE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'trays has exactly one farmsmart_app-scoped DELETE policy'
);

-- ── sensor_readings: SELECT, INSERT (2 policies) ────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sensor_readings'::regclass),
  'row-level security is enabled on public.sensor_readings'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_readings'),
  2, 'sensor_readings has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_readings'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'sensor_readings has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sensor_readings'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'sensor_readings has exactly one farmsmart_app-scoped INSERT policy'
);

-- ── bad_tray_entries: SELECT, INSERT (2 policies) ───────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bad_tray_entries'::regclass),
  'row-level security is enabled on public.bad_tray_entries'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'),
  2, 'bad_tray_entries has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'bad_tray_entries has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bad_tray_entries'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'bad_tray_entries has exactly one farmsmart_app-scoped INSERT policy'
);

-- ── manual_checks: SELECT, INSERT (2 policies) ──────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.manual_checks'::regclass),
  'row-level security is enabled on public.manual_checks'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'manual_checks'),
  2, 'manual_checks has exactly 2 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'manual_checks'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'manual_checks has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'manual_checks'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'manual_checks has exactly one farmsmart_app-scoped INSERT policy'
);

-- ── stock_movements: SELECT ONLY (1 policy) -- no live write path today ────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_movements'::regclass),
  'row-level security is enabled on public.stock_movements'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stock_movements'),
  1, 'stock_movements has exactly 1 policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stock_movements'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'stock_movements has exactly one farmsmart_app-scoped SELECT policy'
);

-- ── cycle_seed_lots: SELECT ONLY (1 policy) -- no live write path today ────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cycle_seed_lots'::regclass),
  'row-level security is enabled on public.cycle_seed_lots'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cycle_seed_lots'),
  1, 'cycle_seed_lots has exactly 1 policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cycle_seed_lots'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'cycle_seed_lots has exactly one farmsmart_app-scoped SELECT policy'
);

-- ── user_settings: SELECT, INSERT, UPDATE (3 policies) -- onConflictDoUpdate
--    needs both INSERT and UPDATE ────────────────────────────────────────────
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_settings'::regclass),
  'row-level security is enabled on public.user_settings'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_settings'),
  3, 'user_settings has exactly 3 policies'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_settings'
     AND cmd = 'SELECT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'user_settings has exactly one farmsmart_app-scoped SELECT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_settings'
     AND cmd = 'INSERT' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'user_settings has exactly one farmsmart_app-scoped INSERT policy'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_settings'
     AND cmd = 'UPDATE' AND coalesce(qual, with_check) LIKE '%farmsmart_app%'),
  1, 'user_settings has exactly one farmsmart_app-scoped UPDATE policy'
);

SELECT * FROM finish();
ROLLBACK;
