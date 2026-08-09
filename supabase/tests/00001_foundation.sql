-- pgTAP assertions for the foundational database state after replaying the
-- full Drizzle + Supabase migration history into a disposable instance.
--
-- Run inside a transaction that is always rolled back, so these assertions
-- leave no side effects on the database. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
BEGIN;

SELECT plan(7);

-- Drizzle migration bookkeeping lives in its own schema (see drizzle.config.ts
-- and lib/db/scripts/migrate.mjs). All 32 Drizzle migrations should have been
-- replayed (0031, TEN-013, is the most recent addition -- adds
-- organizations.is_demo).
SELECT has_table(
  'drizzle',
  '__drizzle_migrations',
  'drizzle.__drizzle_migrations table exists'
);
SELECT is(
  (SELECT count(*) FROM drizzle.__drizzle_migrations)::integer,
  32,
  'drizzle.__drizzle_migrations has exactly 32 rows (full migration history replayed)'
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
-- seed_lots, organization_members) (Task 8). 00008 adds an additive
-- auth.uid()-scoped own-row policy on organization_members. 00009 adds
-- additive current_user-scoped SELECT/UPDATE policies on public.users so the
-- api-server backend's own non-BYPASSRLS role (farmsmart_app, MT-M1 Task 13)
-- can read/update user rows without auth.uid() being set. 00010 adds the
-- same current_user-scoped policies (only the commands each route actually
-- uses) to organizations, wizard_progress, sensor_accounts,
-- facility_readiness_events, and wizard_events -- 00006 enabled RLS on these
-- with zero policies, which only worked while the backend ran as
-- postgres/service_role (BYPASSRLS). 00011 adds an additive current_user-
-- scoped INSERT policy on organization_members so POST /facilities can
-- insert the owner membership row in the same transaction that creates the
-- organization itself (app.org_id can't be set to an org id that doesn't
-- exist yet). 00012 adds an additive current_user-scoped SELECT policy on
-- organization_members -- the CRITICAL fix for resolveTenantContext's own
-- bootstrap lookup, which 00008's auth.uid()-based policy could never
-- satisfy for this backend's connection (found running the TEN-007
-- isolation suite, Task 15, against staging). 00013 alters those same 11
-- policies to wrap current_setting(...) in NULLIF before casting to int --
-- the placeholder GUC's empty-string resting state (once ever referenced on
-- a pooled backend) otherwise throws instead of evaluating to false (Task 16
-- part 2). 00014 adds an additive current_user-scoped UPDATE policy on
-- organization_members -- the invite-accept flow's membership UPSERT
-- (invitationsAccept.ts, ungated) needs UPDATE for its re-join-after-removal
-- conflict path, closing the last gap in the TEN-010 Task 7 review (T7 also
-- rewired members.ts's GET/PATCH/DELETE onto withTenantScope, which needed
-- no new policy since 00007's tenant-isolation policy already covers UPDATE
-- once app.org_id is set). 00015 repoints custom_access_token_hook's
-- `user_role` JWT claim from the deprecated public.users.role (operational
-- axis) to organization_members.role (owner|admin|technician, the single
-- source of truth per ADR-005) for the caller's ACTIVE membership, omitting
-- the claim entirely when no active membership exists, and grants
-- supabase_auth_admin SELECT on organization_members (Task 8). 00016 enables
-- RLS on the invitations table and adds current_user-scoped SELECT/INSERT/
-- UPDATE/DELETE backend policies -- the invitations table shipped with no RLS
-- at all (the only tenant-scoped table without a backstop, and it stores invite
-- token hashes); closes the last gap from the TEN-010 final whole-branch review.
-- 00017 enables RLS on the three TEN-012 sign-up tables (signup_allowlist,
-- access_requests, account_purge_audit) and adds current_user-scoped backend
-- policies for the verbs each flow uses (3/3/2) -- these PII-bearing tables
-- shipped in TEN-012 Task 1 with no RLS at all, the same class of gap 00016
-- closed for invitations. 00018 adds a current_user-scoped DELETE policy on
-- public.organizations so the TEN-012 unverified-account purge can delete the
-- data-less org it provisioned, under the real non-BYPASSRLS farmsmart_app role
-- (organizations had backend SELECT + INSERT policies but no DELETE — caught by
-- the TEN-012 farmsmart_app RLS proof, the BYPASSRLS CI DB masked it).
SELECT is(
  (SELECT count(*) FROM supabase_migrations.schema_migrations)::integer,
  18,
  'supabase_migrations.schema_migrations has exactly 18 rows (Supabase migrations 00001-00018)'
);

SELECT * FROM finish();
ROLLBACK;
