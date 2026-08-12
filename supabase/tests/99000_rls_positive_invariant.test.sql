-- Positive-invariant guard (MT-M2 task #4): every public base/partitioned
-- table has row level security enabled. Named 99000_ so it sorts/runs after
-- every migration test, reflecting the fully-migrated schema.
--
-- This replaces the curated-allowlist mindset (a hand-maintained list of
-- "tables that must have RLS") with a rule that ANY new public table
-- lacking RLS fails CI here -- including if a future table (e.g. TEN-011's
-- signup_config) ships without it. See [[rls-positive-invariant-practice]].
--
-- Qualifying tables: pg_class.relkind IN ('r','p') (ordinary + partitioned)
-- in nspname='public', excluding tables owned by an extension (pg_depend
-- deptype='e' -- e.g. anything the `vector` extension owns) so a
-- third-party extension table can't fail our gate. Views (relkind='v') are
-- excluded -- RLS lives on their base tables, not the view itself.
--
-- Zero curated exceptions today -- all public tables have RLS. If a future
-- table is *intentionally* RLS-exempt, it must be added to an explicit,
-- commented exception set in this test (never silently).
--
-- Complementary run-time cross-check: the Supabase advisor
-- `rls_disabled_in_public` (dashboard / `get_advisors('security')`) is the
-- same invariant enforced at the platform layer on staging/prod. This
-- pgTAP test is the CI enforcement and is self-contained -- no live-project
-- credentials or network dependency.
--
-- Runs inside a transaction that always rolls back; no side effects.
BEGIN;

SELECT plan(1);

-- Positive invariant: every public base/partitioned table (excluding
-- extension-owned) has RLS enabled. Replaces a curated allowlist -- any NEW
-- un-RLS'd public table fails CI here. See [[rls-positive-invariant-practice]].
SELECT is(
  (
    SELECT count(*)::int
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relrowsecurity = false
      -- exclude tables owned by an extension (not ours to gate)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  ),
  0,
  'every public base table has row level security enabled (positive invariant)'
);

-- Diagnostic: on failure, name the offending table(s) so a failing CI run
-- doesn't just report "expected 0, got N" -- it names exactly which
-- table(s) are missing RLS.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offenders
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relrowsecurity = false
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      );

  IF offenders IS NOT NULL THEN
    RAISE NOTICE 'RLS positive-invariant violators (relrowsecurity=false): %', offenders;
    PERFORM diag('RLS positive-invariant violators (relrowsecurity=false): ' || offenders);
  END IF;
END $$;

SELECT * FROM finish();
ROLLBACK;
