-- sensor_status facility-scoped RLS (MT-M2 batch 4). ROLE-AGNOSTIC GUC
-- policies (no current_user / no TO clause), matching 00007's/00022's
-- idiom: cycles.ts (the two upsert call sites) and dashboard.ts both run
-- under withTenantScope after this batch's rescope, so app.facility_id is
-- always set before these queries -- a GUC-scoped policy is both available
-- and correct here, not a current_user backstop.
--
-- Closes a latent cross-tenant commingling bug: sensor_status was
-- previously a single global row with no tenant column at all, so writes
-- from different organizations' cycle operations overwrote the same row
-- (last-write-wins across tenants). facility_id + unique(facility_id)
-- (0033_sensor_status_facility.sql) now gives each facility its own row;
-- this migration's policies enforce that a session can only see/write the
-- row for its own app.facility_id.
--
-- Verbs: SELECT, INSERT, UPDATE only -- the two call sites that touch this
-- table (cycles.ts's upsert, and any facility-scoped read) never DELETE.
--
-- Cast idiom matches 00013/00019/00022: NULLIF(current_setting(...), '')
-- guards against the empty-string placeholder resting state a pooled
-- backend connection can expose -- casting ''::int throws instead of
-- silently evaluating to NULL/false.
--
-- Rollback:
--   drop policy "sensor_status select own facility" on public.sensor_status;
--   drop policy "sensor_status insert own facility" on public.sensor_status;
--   drop policy "sensor_status update own facility" on public.sensor_status;
--   alter table public.sensor_status disable row level security;

alter table public.sensor_status enable row level security;

create policy "sensor_status select own facility" on public.sensor_status for select
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

create policy "sensor_status insert own facility" on public.sensor_status for insert
  with check (facility_id = nullif(current_setting('app.facility_id', true), '')::int);

create policy "sensor_status update own facility" on public.sensor_status for update
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int)
  with check (facility_id = nullif(current_setting('app.facility_id', true), '')::int);
