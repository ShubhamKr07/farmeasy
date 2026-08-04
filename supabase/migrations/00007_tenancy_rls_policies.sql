-- Row-level security for the tenancy-scoped tables added in Tasks 1-6
-- (organization_members, facility_id/organization_id scoping columns).
-- Defense-in-depth alongside the application-layer scoped-query helper
-- (withTenantScope, Task 9) -- see ADR-005/Q31. Policies read session
-- variables set by that helper via SET LOCAL (app.org_id / app.facility_id).
--
-- Note: a bare USING clause with no WITH CHECK (and no explicit FOR
-- command) applies to ALL commands including INSERT -- per Postgres's
-- documented behavior, USING is used for BOTH visibility and the
-- WITH CHECK enforcement when WITH CHECK is omitted. This correctly
-- prevents cross-tenant inserts, not just cross-tenant reads.

alter table public.cycles enable row level security;
alter table public.inventory_items enable row level security;
alter table public.alerts enable row level security;
alter table public.tasks enable row level security;
alter table public.shipments enable row level security;
alter table public.facility_logs enable row level security;
alter table public.sensors enable row level security;
alter table public.growth_profiles enable row level security;
alter table public.accounting_connections enable row level security;
alter table public.seed_lots enable row level security;
alter table public.organization_members enable row level security;

revoke all on public.cycles from anon, authenticated;
revoke all on public.inventory_items from anon, authenticated;
revoke all on public.alerts from anon, authenticated;
revoke all on public.tasks from anon, authenticated;
revoke all on public.shipments from anon, authenticated;
revoke all on public.facility_logs from anon, authenticated;
revoke all on public.sensors from anon, authenticated;
revoke all on public.growth_profiles from anon, authenticated;
revoke all on public.accounting_connections from anon, authenticated;
revoke all on public.seed_lots from anon, authenticated;
revoke all on public.organization_members from anon, authenticated;

create policy "tenant isolation by facility"
  on public.cycles
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.inventory_items
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.alerts
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.tasks
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.shipments
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.facility_logs
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by facility"
  on public.sensors
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by organization"
  on public.growth_profiles
  using (organization_id = current_setting('app.org_id', true)::int);

create policy "tenant isolation by organization"
  on public.accounting_connections
  using (organization_id = current_setting('app.org_id', true)::int);

create policy "tenant isolation by facility"
  on public.seed_lots
  using (facility_id = current_setting('app.facility_id', true)::int);

create policy "tenant isolation by organization"
  on public.organization_members
  using (organization_id = current_setting('app.org_id', true)::int);
