-- supabase/migrations/00013_tenancy_policies_nullif_guc_cast.sql
--
-- 00007's 11 tenant-isolation policies all cast a custom GUC directly:
-- `col = current_setting('app.facility_id'/'app.org_id', true)::int`.
--
-- Postgres custom (non-extension) GUCs are placeholders: the FIRST time any
-- code calls set_config() for a given name on a given physical backend
-- connection, Postgres permanently creates that placeholder for the
-- lifetime of the backend process -- even if the transaction that first
-- referenced it later rolls back. After that point, current_setting(name,
-- true) (missing_ok) no longer returns NULL when nothing is currently set
-- locally -- it returns an empty string, because the placeholder exists but
-- has no active local value. Casting ''::int THROWS
-- ("invalid input syntax for type integer: \"\"") rather than evaluating to
-- NULL/false.
--
-- Confirmed empirically against staging (see docs/superpowers/plans/
-- 2026-08-04-multi-tenancy-mt-m1-isolation-core.md's "Task 16, part 2" for
-- the full writeup): a fresh psql session already showed
-- current_setting('app.org_id', true) as '' before this session did
-- anything, because Supabase's transaction-mode pooler (Supavisor, port
-- 6543 -- this app's real connection mode per ADR-003/004) reuses physical
-- backend connections across unrelated logical requests. Once ANY request
-- has ever run withTenantScope (lib/db/src/scope.ts's set_config calls) on
-- a given backend, every LATER query on that same backend that doesn't
-- itself set app.org_id/app.facility_id -- including
-- resolveTenantContext's own bootstrap lookup, or any request that
-- legitimately has no tenant context yet -- can throw this error. Worse:
-- for INSERT, Postgres evaluates ALL applicable permissive policies for the
-- command (not just the first one that would pass) -- if 00007's bare-cast
-- policy throws during evaluation, the whole statement aborts even when
-- another policy (e.g. 00011's current_user-scoped one) would have
-- separately permitted it. Reproduced directly: POST /facilities's
-- organization_members insert failed this way during Task 15's isolation-
-- suite run against staging.
--
-- This is a real production reliability hazard under connection pooling --
-- not a silent security bypass (the failure mode is a thrown error/500,
-- fail-closed, not a wrongly-permitted row) but a standing source of
-- unpredictable failures as the pool cycles through requests.
--
-- Fix: NULLIF(current_setting(...), '') converts the empty-string
-- placeholder resting-state to a real NULL before the cast, so the
-- comparison evaluates to NULL (-> false, correctly denying access) instead
-- of throwing. Verified directly against staging:
--   SELECT NULLIF(current_setting('app.org_id', true), '')::int IS NULL;  -- true
--
-- ALTER POLICY (not drop/recreate) preserves each policy's identity/OID.

alter policy "tenant isolation by facility" on public.cycles
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.inventory_items
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.alerts
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.tasks
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.shipments
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.facility_logs
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by facility" on public.sensors
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by organization" on public.growth_profiles
  using (organization_id = nullif(current_setting('app.org_id', true), '')::int);

alter policy "tenant isolation by organization" on public.accounting_connections
  using (organization_id = nullif(current_setting('app.org_id', true), '')::int);

alter policy "tenant isolation by facility" on public.seed_lots
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

alter policy "tenant isolation by organization" on public.organization_members
  using (organization_id = nullif(current_setting('app.org_id', true), '')::int);
