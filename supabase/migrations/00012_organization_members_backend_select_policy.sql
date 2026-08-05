-- supabase/migrations/00012_organization_members_backend_select_policy.sql
--
-- CRITICAL: resolveTenantContext (middlewares/tenantContext.ts) does a bare
-- db.select() from organization_members joined to facilities, filtered by
-- userId -- deliberately NOT wrapped in withTenantScope, since discovering
-- the tenant context is exactly what this query is for (chicken-and-egg:
-- app.org_id can't be set before the org is known). Under farmsmart_app,
-- this SELECT needs an RLS policy to admit it. The only existing policies on
-- this table are 00007's current_setting('app.org_id')-based one (can't
-- apply here -- org_id isn't known yet) and 00008's auth.uid()-based one.
--
-- 00008's policy has never actually been usable by this backend: auth.uid()
-- reads a Postgres session GUC (request.jwt.claims) that Supabase's own
-- PostgREST/Auth stack populates from a live JWT -- this Express backend's
-- pooled connection (withTenantScope, lib/db/src/scope.ts) only ever sets
-- app.org_id/app.facility_id via set_config(), never anything auth.uid()
-- reads. 00008 is presumably meant for a direct Supabase-client consumer
-- (e.g. a future mobile client with its own real JWT session), same
-- reasoning as the original public.users policies (00002) -- not something
-- to remove, just something this backend's own bootstrap lookup can never
-- satisfy.
--
-- Without this fix, EVERY authenticated request to EVERY tenant-scoped
-- route silently gets zero rows back from resolveTenantContext regardless
-- of whether the user's membership actually exists, req.tenant stays
-- undefined, and every route using requireTenantContext/withTenantScope
-- 403s or throws "withTenantScope called without a resolvable organization
-- context" -- universal breakage under a real non-BYPASSRLS role, found
-- while running the TEN-007 cross-tenant isolation suite (Task 15) against
-- staging with farmsmart_app.
--
-- Additive current_user-scoped policy, same pattern as 00009/00010/00011.
create policy "backend service role can read organization members"
  on public.organization_members
  for select
  using (current_user = 'farmsmart_app');
