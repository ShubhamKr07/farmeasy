-- supabase/migrations/00010_onboarding_tables_backend_role_policy.sql
--
-- 00006_onboarding_tables_rls.sql enabled RLS on organizations,
-- wizard_progress, sensor_accounts, facility_readiness_events, and
-- wizard_events, then only revoked anon/authenticated grants -- it added no
-- CREATE POLICY at all. That was safe only because every real read/write of
-- these tables went through the api-server backend's postgres/service_role
-- connection (BYPASSRLS). Rotating the backend to a genuinely least-
-- privilege role (farmsmart_app, MT-M1 Task 13) means these five tables now
-- have zero policies -- RLS with no policies denies every row to any
-- non-BYPASSRLS role, including the backend's own.
--
-- None of these tables are facility/org-scoped the way 00007's tables are
-- (organizations IS the tenant; wizard_progress/sensor_accounts/
-- facility_readiness_events/wizard_events are keyed by user_id or facility_id
-- but predate the withTenantScope/current_setting pattern and are exercised
-- before a tenant context necessarily exists, e.g. mid-onboarding). Same
-- current_user-scoped additive pattern as 00009 (public.users): grant the
-- backend's own trusted role exactly the commands its real routes use, no
-- more.
--
-- Per-table command scope, verified against actual route usage:
--   organizations              -- select (growthProfiles.ts default-org
--                                  lookup), insert (facilities.ts POST)
--   wizard_progress            -- select, insert, update (wizard.ts GET/PUT,
--                                  upsert via onConflictDoUpdate)
--   sensor_accounts            -- select, insert, update
--                                  (sensor-accounts.ts)
--   facility_readiness_events  -- select, insert, update
--                                  (facility-readiness.ts, upsert via
--                                  onConflictDoUpdate)
--   wizard_events              -- insert only (wizard-events.ts; append-only
--                                  event log, never read back by the API)

create policy "backend service role can read organizations"
  on public.organizations
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert organizations"
  on public.organizations
  for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can read wizard progress"
  on public.wizard_progress
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert wizard progress"
  on public.wizard_progress
  for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update wizard progress"
  on public.wizard_progress
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can read sensor accounts"
  on public.sensor_accounts
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert sensor accounts"
  on public.sensor_accounts
  for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update sensor accounts"
  on public.sensor_accounts
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can read facility readiness events"
  on public.facility_readiness_events
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert facility readiness events"
  on public.facility_readiness_events
  for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update facility readiness events"
  on public.facility_readiness_events
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can insert wizard events"
  on public.wizard_events
  for insert
  with check (current_user = 'farmsmart_app');
