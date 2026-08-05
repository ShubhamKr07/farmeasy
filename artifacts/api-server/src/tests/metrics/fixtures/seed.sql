-- Golden-fixture seed for /api/metrics template tests.
-- Deterministic rows with hand-computed expected values (see fixtures/expected.ts).
-- Run against TEST_DATABASE_URL only (never prod). Tests TRUNCATE first.

BEGIN;

TRUNCATE
  sensor_readings, sensors, stock_movements, bad_tray_entries, tasks,
  alerts, shipments, inventory_items, cycle_seed_lots, cycles,
  seed_lots, growth_profiles, crops, channels, rooms, facilities, organizations
RESTART IDENTITY CASCADE;

-- organizations/facilities seeded first: growth_profiles.organization_id and
-- every tenant-scoped table below (seed_lots/cycles/shipments/
-- inventory_items/alerts/tasks/sensors) gained a NOT NULL facility_id/
-- organization_id column (MT-M1 tenancy-scoping migrations, 0018-0025) and
-- FK to organizations/facilities -- both must exist before anything
-- referencing them is inserted.
INSERT INTO organizations (id, name) VALUES
  (1, 'Test Org');

INSERT INTO facilities (id, name, organization_id, facility_name, timezone) VALUES
  (1, 'Test Farm', 1, 'Test Farm', 'UTC');

INSERT INTO crops (id, name, scientific_name, category) VALUES
  (1, 'Basil', 'Ocimum basilicum', 'herb'),
  (2, 'Lettuce', 'Lactuca sativa', 'leafy');

INSERT INTO growth_profiles (id, name, seed_name, germination_days, fertigation_days, crop_id, expected_yield_per_tray_kg, organization_id)
VALUES
  (1, 'Basil profile', 'Basil', 4, 8, 1, 1.2, 1),
  (2, 'Lettuce profile', 'Lettuce', 3, 10, 2, 0.9, 1);

INSERT INTO seed_lots (id, qr_code, seed_name, currently_grown, success, grow_time, facility_id)
VALUES
  (1, 'QR-BASIL-1', 'Basil', true, 95, 12, 1),
  (2, 'QR-LETTUCE-1', 'Lettuce', true, 90, 13, 1);

-- 4 cycles: 2 completed (closed June 2026), 1 germination, 1 fertigation.
INSERT INTO cycles (id, short_id, seed_lot_qr_codes, seed_name, full_trays, half_trays, seed_weight_tray, growth_profile_id, seeding_date, status, harvested_qty, closed_at, deleted_at, facility_id)
VALUES
  (1, 'C1', ARRAY['QR-BASIL-1'], 'Basil', 10, 0, 5, 1, '2026-06-01', 'completed', 1000, '2026-06-15 12:00:00', NULL, 1),
  (2, 'C2', ARRAY['QR-BASIL-1'], 'Basil', 10, 0, 5, 1, '2026-06-05', 'completed', 2000, '2026-06-20 12:00:00', NULL, 1),
  (3, 'C3', ARRAY['QR-LETTUCE-1'], 'Lettuce', 8, 2, 4, 2, '2026-07-01', 'germination', NULL, NULL, NULL, 1),
  (4, 'C4', ARRAY['QR-BASIL-1'], 'Basil', 6, 4, 5, 1, '2026-06-25', 'fertigation', NULL, NULL, NULL, 1);

INSERT INTO cycle_seed_lots (cycle_id, seed_lot_id, qty) VALUES
  (1, 1, 50), (2, 1, 50), (3, 2, 40), (4, 1, 30);

INSERT INTO shipments (id, short_id, client, yield_sold_kg, revenue_usd, shipping_date, status, cycle_id, deleted_at, facility_id)
VALUES
  (1, 'S1', 'Acme', 10, 500, '2026-06-16', 'complete', 1, NULL, 1),
  (2, 'S2', 'Beta', 5, 300, '2026-06-21', 'pending', 2, NULL, 1),
  (3, 'S3', 'Acme', 0, NULL, '2026-07-02', 'pending', NULL, NULL, 1);

INSERT INTO inventory_items (id, name, category, current_qty, max_qty, unit, arrival_date, deleted_at, facility_id)
VALUES
  (1, 'Seeds', 'seeds', 5, 100, 'g', '2026-06-01', NULL, 1),
  (2, 'Trays', 'supplies', 0, 50, 'count', '2026-06-10', NULL, 1);

INSERT INTO stock_movements (id, inventory_item_id, cycle_id, delta, reason, created_at)
VALUES
  (1, 1, 1,  50, 'purchase', '2026-06-01 09:00:00'),
  (2, 1, 1, -10, 'consume',  '2026-06-15 09:00:00'),
  (3, 2, NULL,  20, 'purchase', '2026-06-10 09:00:00'),
  (4, 1, 2,  -5, 'adjust',   '2026-06-20 09:00:00');

INSERT INTO alerts (id, title, severity, status, location, created_at, facility_id)
VALUES
  (1, 'Temp high', 'critical', 'current', 'Room A', '2026-06-10 09:00:00', 1),
  (2, 'pH drift',  'warning',  'current', 'Room B', '2026-06-12 09:00:00', 1),
  (3, 'Old',       'warning',  'resolved','Room A', '2026-06-01 09:00:00', 1);

INSERT INTO tasks (id, cycle_id, type, status, assignee, due_at, completed_at, facility_id)
VALUES
  (1, 3, 'seed',      'done',        'Alice', '2026-07-02 09:00:00', '2026-07-02 09:00:00', 1),
  (2, 4, 'transplant','in_progress', 'Bob',   '2026-07-05 09:00:00', NULL, 1);

INSERT INTO bad_tray_entries (id, cycle_id, issue, severity, full_trays, half_trays, loss_estimate, created_at)
VALUES
  (1, 1, 'mold',    'high',   2, 0, 200, '2026-06-14 09:00:00'),
  (2, 2, 'dry',     'low',    1, 1, 50,  '2026-06-19 09:00:00');

-- sensors.channel_id/rack_id has a CHECK requiring at least one non-null
-- (sensors_placement), so a minimal room/channel is seeded for placement.
INSERT INTO rooms (id, name, sort_order, facility_id) VALUES
  (1, 'seeding', 0, 1);

INSERT INTO channels (id, room_id, label, position_index) VALUES
  (1, 1, 'Room A', 0);

INSERT INTO sensors (id, channel_id, rack_id, type, label, unit, last_value, last_read_at, facility_id)
VALUES
  (1, 1, NULL, 'temp', 'Room A temp', 'C', 24, '2026-07-03 10:00:00', 1);

INSERT INTO sensor_readings (id, sensor_id, metric, value, read_at)
VALUES
  (1, 1, 'temp', 24, '2026-07-03 09:00:00'),
  (2, 1, 'temp', 25, '2026-07-03 10:00:00');

COMMIT;
