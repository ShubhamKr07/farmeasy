-- pgTAP assertions for the foundational database state after replaying the
-- full Drizzle + Supabase migration history into a disposable instance.
--
-- Run inside a transaction that is always rolled back, so these assertions
-- leave no side effects on the database. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
BEGIN;

SELECT plan(7);

-- Drizzle migration bookkeeping lives in its own schema (see drizzle.config.ts
-- and lib/db/scripts/migrate.mjs). All 25 Drizzle migrations should have been
-- replayed.
SELECT has_table(
  'drizzle',
  '__drizzle_migrations',
  'drizzle.__drizzle_migrations table exists'
);
SELECT is(
  (SELECT count(*) FROM drizzle.__drizzle_migrations)::integer,
  25,
  'drizzle.__drizzle_migrations has exactly 25 rows (full migration history replayed)'
);

-- Core application table seeded by the Drizzle schema.
SELECT has_table(
  'public',
  'users',
  'public.users table exists'
);

-- The user_role enum underpins auth claims (custom_access_token_hook).
SELECT has_type(
  'public',
  'user_role',
  'public.user_role enum type exists'
);

-- The custom access token hook injects user_role into JWT claims.
SELECT has_function(
  'public',
  'custom_access_token_hook',
  ARRAY['jsonb']::text[],
  'public.custom_access_token_hook(jsonb) function exists'
);

-- The media storage bucket backs user-uploaded photos.
SELECT is(
  (SELECT count(*) FROM storage.buckets WHERE id = 'media')::integer,
  1,
  'media bucket exists in storage.buckets'
);

-- Supabase's own migration ledger should reflect the seven Supabase
-- migrations (00001-00007) applied via `supabase db push --include-all`.
-- 00004_create_auth_profiles.sql installs the profile-provisioning trigger
-- and removes the self-UPDATE policy (Task 1). 00005_private_media.sql
-- backfills legacy photo-URL references and makes the media bucket private
-- (Task 12). 00006_onboarding_tables_rls.sql enables RLS + revokes direct
-- grants on the onboarding-wizard tables (organizations, wizard_progress,
-- sensor_accounts, facility_readiness_events, wizard_events).
-- 00007_tenancy_rls_policies.sql enables RLS + revokes direct grants and
-- adds tenant-isolation policies keyed on app.facility_id / app.org_id on
-- the scoped tables (cycles, inventory_items, alerts, tasks, shipments,
-- facility_logs, sensors, growth_profiles, accounting_connections,
-- seed_lots, organization_members) (Task 8).
SELECT is(
  (SELECT count(*) FROM supabase_migrations.schema_migrations)::integer,
  8,
  'supabase_migrations.schema_migrations has exactly 8 rows (Supabase migrations 00001-00008)'
);

SELECT * FROM finish();
ROLLBACK;
