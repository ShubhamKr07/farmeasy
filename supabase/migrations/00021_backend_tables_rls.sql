-- MT-M2 public-RLS remediation, Batch 2: the 10 backend-only, no-tenant-column
-- public tables (rooms, channels, racks, trays, sensor_readings,
-- bad_tray_entries, manual_checks, stock_movements, cycle_seed_lots,
-- user_settings). Same Option-A model as Batch 1 (facilities, 00020) and
-- organizations/organization_members/invitations/signup (00010/00011/00012/
-- 00014/00016/00017/00018): current_user = 'farmsmart_app' backend policies,
-- NOT a GUC-scoped (app.org_id/app.facility_id) policy. All 10 are backend-
-- only (no PostgREST/anon/authenticated grants), low-sensitivity structural/
-- operational data, and several are read in bootstrap or facility-wide
-- contexts (layout GET, metrics registry) that never set app.org_id/
-- app.facility_id -- a GUC policy would return 0 rows there. Denormalizing
-- facility_id onto these tables was explicitly rejected (see
-- docs/superpowers/specs/2026-08-10-mt-m2-public-rls-remediation-design.md,
-- Batch 2) -- this closes the advisor's actual threat (direct-to-Postgres
-- access by a non-backend role, or a future stray GRANT) with zero
-- runtime/rollout risk and no schema change.
--
-- Per-verb audit (grepped against artifacts/api-server/src/{routes,lib} AND
-- lib/metrics/src's metric registries, which also run backend SELECTs against
-- 2 of these tables via generic query templates -- confirmed empirically,
-- not assumed from the plan's initial guess):
--   rooms            -- SELECT (layout.ts GET /layout), INSERT (facilities.ts
--                       POST /facilities room-seeding). No UPDATE/DELETE route.
--   channels         -- SELECT, INSERT, UPDATE, DELETE (layout.ts POST/PATCH/
--                       DELETE /layout/channels[/:id]).
--   racks            -- SELECT, INSERT, UPDATE, DELETE (layout.ts POST/PATCH/
--                       DELETE /layout/racks[/:id], tray-count PATCH).
--   trays            -- SELECT, INSERT, DELETE (layout.ts POST/DELETE
--                       /layout/trays[/:id], rack tray-count rebalancing). No
--                       UPDATE route.
--   sensor_readings  -- SELECT, INSERT (sensor-readings.ts GET/POST; also
--                       inserted by lib/db/src/seed/seedDemoOrg.ts under the
--                       same farmsmart_app connection).
--   bad_tray_entries -- SELECT (dashboard.ts loss-estimate aggregate), INSERT
--                       (cycles.ts harvest/manual-check completion, both
--                       withTenantScope-wrapped transactions).
--   manual_checks    -- SELECT (dashboard.ts, cycles.ts, badTrays.ts GET
--                       /bad-trays), INSERT (cycles.ts, badTrays.ts POST
--                       /bad-trays/manual-checks). No UPDATE/DELETE route.
--   stock_movements  -- SELECT ONLY. No route/lib code in this repo currently
--                       writes to stock_movements (inventory.ts never
--                       references it) -- it is read exclusively via the
--                       metrics registry's generic timeBucket/groupBy/
--                       scalarAgg templates (lib/metrics/src/registry-
--                       inventory.ts) and lib/metrics/custom.ts's hand-written
--                       SUM(delta) queries, both dispatched from routes/
--                       metrics.ts under withTenantScope. Only a SELECT policy
--                       is added -- adding unused INSERT/UPDATE/DELETE
--                       policies would violate "add a policy for exactly the
--                       audited verbs."
--   cycle_seed_lots  -- SELECT ONLY, same reasoning as stock_movements: no
--                       route/lib code writes this junction table today (cycle
--                       seed-lot associations are actually stored as a
--                       seedLotQrCodes array column ON cyclesTable itself, not
--                       via this table). Read via the metrics registry's
--                       generic groupBy template (registry-overview.ts's
--                       "ov.seedlots.usage") and tz.ts's facility-scope
--                       subquery map.
--   user_settings    -- SELECT (userSettings.ts GET), INSERT AND UPDATE
--                       (userSettings.ts PUT uses .onConflictDoUpdate() --
--                       Postgres requires BOTH the INSERT policy's WITH CHECK
--                       and the UPDATE policy's USING/WITH CHECK to admit an
--                       INSERT ... ON CONFLICT DO UPDATE; omitting the UPDATE
--                       policy would silently break every settings write to
--                       an existing key under the real role).
--
-- STRUCTURAL note: pgTAP proof (00021_backend_tables_rls.test.sql) asserts
-- RLS-enabled + policy presence/predicate only -- the farmsmart_app role does
-- not exist in the disposable-CI database (same convention as 00016-00020).
-- The functional proof is the full api-server suite green under the new RLS,
-- run against the real non-BYPASSRLS role via the disposable stack.
--
-- Rollback:
--   drop policy "backend service role can select rooms" on public.rooms;
--   drop policy "backend service role can insert rooms" on public.rooms;
--   alter table public.rooms disable row level security;
--   drop policy "backend service role can select channels" on public.channels;
--   drop policy "backend service role can insert channels" on public.channels;
--   drop policy "backend service role can update channels" on public.channels;
--   drop policy "backend service role can delete channels" on public.channels;
--   alter table public.channels disable row level security;
--   drop policy "backend service role can select racks" on public.racks;
--   drop policy "backend service role can insert racks" on public.racks;
--   drop policy "backend service role can update racks" on public.racks;
--   drop policy "backend service role can delete racks" on public.racks;
--   alter table public.racks disable row level security;
--   drop policy "backend service role can select trays" on public.trays;
--   drop policy "backend service role can insert trays" on public.trays;
--   drop policy "backend service role can delete trays" on public.trays;
--   alter table public.trays disable row level security;
--   drop policy "backend service role can select sensor_readings" on public.sensor_readings;
--   drop policy "backend service role can insert sensor_readings" on public.sensor_readings;
--   alter table public.sensor_readings disable row level security;
--   drop policy "backend service role can select bad_tray_entries" on public.bad_tray_entries;
--   drop policy "backend service role can insert bad_tray_entries" on public.bad_tray_entries;
--   alter table public.bad_tray_entries disable row level security;
--   drop policy "backend service role can select manual_checks" on public.manual_checks;
--   drop policy "backend service role can insert manual_checks" on public.manual_checks;
--   alter table public.manual_checks disable row level security;
--   drop policy "backend service role can select stock_movements" on public.stock_movements;
--   alter table public.stock_movements disable row level security;
--   drop policy "backend service role can select cycle_seed_lots" on public.cycle_seed_lots;
--   alter table public.cycle_seed_lots disable row level security;
--   drop policy "backend service role can select user_settings" on public.user_settings;
--   drop policy "backend service role can insert user_settings" on public.user_settings;
--   drop policy "backend service role can update user_settings" on public.user_settings;
--   alter table public.user_settings disable row level security;

-- rooms: SELECT, INSERT.
alter table public.rooms enable row level security;

create policy "backend service role can select rooms"
  on public.rooms for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert rooms"
  on public.rooms for insert
  with check (current_user = 'farmsmart_app');

-- channels: SELECT, INSERT, UPDATE, DELETE.
alter table public.channels enable row level security;

create policy "backend service role can select channels"
  on public.channels for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert channels"
  on public.channels for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update channels"
  on public.channels for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete channels"
  on public.channels for delete
  using (current_user = 'farmsmart_app');

-- racks: SELECT, INSERT, UPDATE, DELETE.
alter table public.racks enable row level security;

create policy "backend service role can select racks"
  on public.racks for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert racks"
  on public.racks for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update racks"
  on public.racks for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete racks"
  on public.racks for delete
  using (current_user = 'farmsmart_app');

-- trays: SELECT, INSERT, DELETE. No UPDATE -- nothing updates trays today.
alter table public.trays enable row level security;

create policy "backend service role can select trays"
  on public.trays for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert trays"
  on public.trays for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete trays"
  on public.trays for delete
  using (current_user = 'farmsmart_app');

-- sensor_readings: SELECT, INSERT. No UPDATE/DELETE -- append-only time series.
alter table public.sensor_readings enable row level security;

create policy "backend service role can select sensor_readings"
  on public.sensor_readings for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert sensor_readings"
  on public.sensor_readings for insert
  with check (current_user = 'farmsmart_app');

-- bad_tray_entries: SELECT, INSERT. No UPDATE/DELETE -- append-only QA log.
alter table public.bad_tray_entries enable row level security;

create policy "backend service role can select bad_tray_entries"
  on public.bad_tray_entries for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert bad_tray_entries"
  on public.bad_tray_entries for insert
  with check (current_user = 'farmsmart_app');

-- manual_checks: SELECT, INSERT. No UPDATE/DELETE -- append-only QA log.
alter table public.manual_checks enable row level security;

create policy "backend service role can select manual_checks"
  on public.manual_checks for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert manual_checks"
  on public.manual_checks for insert
  with check (current_user = 'farmsmart_app');

-- stock_movements: SELECT ONLY -- no live write path today (see audit note
-- above). Add INSERT/UPDATE/DELETE policies in a follow-up migration if/when
-- a write path is built; do not pre-emptively grant unused verbs.
alter table public.stock_movements enable row level security;

create policy "backend service role can select stock_movements"
  on public.stock_movements for select
  using (current_user = 'farmsmart_app');

-- cycle_seed_lots: SELECT ONLY -- no live write path today (see audit note
-- above).
alter table public.cycle_seed_lots enable row level security;

create policy "backend service role can select cycle_seed_lots"
  on public.cycle_seed_lots for select
  using (current_user = 'farmsmart_app');

-- user_settings: SELECT, INSERT, UPDATE (the PUT route's
-- .onConflictDoUpdate() requires both INSERT and UPDATE policies -- see audit
-- note above). No DELETE route.
alter table public.user_settings enable row level security;

create policy "backend service role can select user_settings"
  on public.user_settings for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert user_settings"
  on public.user_settings for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update user_settings"
  on public.user_settings for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');
