-- MT-M2 public-RLS remediation, Batch 1: facilities.
-- facilities shipped with NO row level security (it is read in many bootstrap
-- contexts before app.org_id/withTenantScope exists -- GET /facilities,
-- wizard org-resolution, demo getOwnerOrg, the unverified-purge sweep -- so a
-- GUC-scoped (app.org_id) policy would return 0 rows and break onboarding).
-- The correct backstop is current_user = 'farmsmart_app' (same model as
-- organizations 00010 / organization_members 00012 / invitations 00016): admit
-- only the backend role, which already self-scopes every facilities access by a
-- server-resolved organization_id WHERE (never client input; TEN-013-attested).
-- This closes direct-to-Postgres access by non-backend roles. Verbs facilities'
-- routes actually use: SELECT (facilities/wizard/demo/growthProfiles/metrics/
-- purgeUnverified), INSERT (facilities POST, demo provision), DELETE (demo
-- graduate). No UPDATE policy -- nothing updates facilities today.
-- Rollback:
--   drop policy "backend service role can select facilities" on public.facilities;
--   drop policy "backend service role can insert facilities" on public.facilities;
--   drop policy "backend service role can delete facilities" on public.facilities;
--   alter table public.facilities disable row level security;

alter table public.facilities enable row level security;

create policy "backend service role can select facilities"
  on public.facilities for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert facilities"
  on public.facilities for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete facilities"
  on public.facilities for delete
  using (current_user = 'farmsmart_app');
