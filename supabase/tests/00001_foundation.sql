-- pgTAP assertions for the foundational database state after replaying the
-- full Drizzle + Supabase migration history into a disposable instance.
--
-- Run inside a transaction that is always rolled back, so these assertions
-- leave no side effects on the database. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
BEGIN;

SELECT plan(7);

-- Drizzle migration bookkeeping lives in its own schema (see drizzle.config.ts
-- and lib/db/scripts/migrate.mjs). All 35 Drizzle migrations should have been
-- replayed (0034, TEN-011, is the most recent addition -- adds the
-- signup_config singleton table, seeded mode='off').
SELECT has_table(
  'drizzle',
  '__drizzle_migrations',
  'drizzle.__drizzle_migrations table exists'
);
SELECT is(
  (SELECT count(*) FROM drizzle.__drizzle_migrations)::integer,
  35,
  'drizzle.__drizzle_migrations has exactly 35 rows (full migration history replayed)'
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
-- the TEN-012 farmsmart_app RLS proof, the BYPASSRLS CI DB masked it). 00019
-- adds a current_user- and app.org_id-scoped UPDATE policy on organizations
-- so TEN-013's demo-fork provision/graduate endpoints can flip
-- organizations.is_demo under the real non-BYPASSRLS role (organizations
-- had backend SELECT/INSERT/DELETE but no UPDATE). 00020 (MT-M2 public-RLS
-- remediation, Batch 1) enables RLS on public.facilities and adds 3
-- current_user-scoped backend policies (SELECT/INSERT/DELETE, no UPDATE --
-- nothing updates facilities today) -- facilities shipped with no row level
-- security at all through 00019; the current_user model (not app.org_id GUC)
-- is required because facilities is read in bootstrap contexts before any
-- tenant GUC is set (GET /facilities, wizard org-resolution, demo
-- getOwnerOrg, the unverified-purge sweep). 00021 (MT-M2 public-RLS
-- remediation, Batch 2) enables RLS on the 10 remaining backend-only,
-- no-tenant-column public tables (rooms, channels, racks, trays,
-- sensor_readings, bad_tray_entries, manual_checks, stock_movements,
-- cycle_seed_lots, user_settings) and adds current_user-scoped per-verb
-- backend policies audited against their actual route/lib usage (see
-- 00021's own header for the full per-table verb list and rationale --
-- stock_movements/cycle_seed_lots are SELECT-only today; user_settings needs
-- both INSERT and UPDATE for its onConflictDoUpdate upsert path). 00022
-- (MT-M2 public-RLS remediation, Batch 3) enables RLS on public.crops with
-- ROLE-AGNOSTIC app.org_id GUC policies (no current_user clause, no TO
-- clause) -- unlike Batches 1/2's backend-backstop tables, crops must be
-- readable by both farmsmart_app and the task-#5 farmsmart_recommender role,
-- so SELECT admits organization_id IS NULL (shared system crops) OR
-- organization_id = app.org_id (an org's own crops); INSERT/UPDATE/DELETE
-- are restricted to an org's own rows. 00023 (MT-M2 task #5, recommender
-- tenant-scoped read role) enables RLS on the last two RLS-less public
-- tables the recommender touches -- recommender_cache (a global,
-- non-tenant web-search cache: SELECT+INSERT admitting both
-- farmsmart_recommender and farmsmart_app) and recommender_queries (a
-- per-user query audit log: SELECT+INSERT scoped to farmsmart_recommender,
-- app-layer scopes by user_id) -- and adds a farmsmart_recommender SELECT
-- policy on bad_tray_entries (00021 shipped it with only a farmsmart_app
-- policy, which doesn't admit the new recommender role; unscoped at the row
-- level -- farm_context.py's `JOIN cycles` is what scopes it to the
-- querying tenant, via 00007's facility-GUC policy on cycles). 00024
-- (MT-M2 public-RLS remediation, Batch 4) enables RLS on public.sensor_status
-- with ROLE-AGNOSTIC app.facility_id GUC policies (SELECT/INSERT/UPDATE,
-- matching cycles.ts's/dashboard.ts's rescoped call sites) -- the last
-- public table lacking RLS entirely, closing task #4's last no-RLS-at-all
-- gap on public tables.
SELECT is(
  (SELECT count(*) FROM supabase_migrations.schema_migrations)::integer,
  24,
  'supabase_migrations.schema_migrations has exactly 24 rows (Supabase migrations 00001-00024)'
);

SELECT * FROM finish();
ROLLBACK;
