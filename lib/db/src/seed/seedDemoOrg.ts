import type { db } from "../index.js";
import {
  growthProfilesTable,
  seedLotsTable,
  cyclesTable,
  sensorsTable,
  sensorReadingsTable,
  alertsTable,
  tasksTable,
  inventoryItemsTable,
  facilityLogsTable,
} from "../index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Canonical TEN-013 demo dataset — the single source of truth for what an
 * "Explore a demo" org looks like. Called by POST /api/demo/provision (live,
 * under farmsmart_app RLS) and by scripts/src/seed-demo-data.ts (dev CLI).
 *
 * Caller contract: `tx` already has app.org_id AND app.facility_id set (the
 * live endpoint sets both inside its transaction; the CLI runs as a BYPASSRLS
 * dev role where the GUCs are harmless no-ops).
 *
 * FK-cascade audit (every table below is a confirmed cascade-safe child of
 * `facilities`, deleting the facility tears every row down to zero):
 *   seed_lots, cycles, sensors (→ sensor_readings cascades transitively),
 *   alerts, tasks, inventory_items, facility_logs — all `ON DELETE CASCADE`
 *   on facility_id. `growth_profiles` is org-scoped (`ON DELETE CASCADE` on
 *   organization_id, not facility_id) and created fresh for the demo org
 *   here — never copied from another org — so it also tears down once the
 *   whole org is gone, though it outlives a facility-only delete (see
 *   POST /demo/graduate, which explicitly deletes the two `(demo)` profiles
 *   in the same transaction as the facility delete).
 *   FORBIDDEN — never write to these: `manual_checks`, `bad_tray_entries`.
 *   Both are `ON DELETE RESTRICT` children of `cycles` — a single seeded row
 *   in either would make the demo facility undeletable and break graduate.
 *
 * Two schema footguns NOT scoped to facility_id that a naive copy of
 * scripts/src/seed-demo-data.ts's literals would hit the second time this
 * runs for a different org (the CLI's original literals only ever ran once
 * against one dev database, so this never surfaced there):
 *   - `cycles.short_id` has a single table-wide UNIQUE constraint (not
 *     per-facility) — the literal "d001".."d010" values collide across
 *     different demo orgs' provisions. Fixed by suffixing every short_id
 *     with facilityId.
 *   - `alerts` has a partial unique index on (title, location) WHERE
 *     status='current', also NOT scoped to facility_id — two demo orgs each
 *     provisioning a "Low EC" alert at the same location text would collide.
 *     Fixed by folding facilityId into the location text.
 * `seed_lots.qr_code` is safe as-is: its unique index is (facility_id,
 * qr_code), so identical QR codes across different demo facilities never
 * collide.
 *
 * Row counts kept modest (dozens) so provision stays a sub-second sync tx.
 */
export async function seedDemoOrg(
  tx: Tx,
  { organizationId, facilityId, userId }: { organizationId: number; facilityId: number; userId: string },
): Promise<void> {
  function daysAgo(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  }
  function isoDate(d: Date): string {
    return d.toISOString().split("T")[0]!;
  }

  // 1. Two org-scoped growth profiles the demo cycles reference — same
  //    germination/fertigation windows as scripts/src/seed-demo-data.ts's
  //    p1/p5 (predictable overdue behaviour below).
  const [p1] = await tx
    .insert(growthProfilesTable)
    .values({
      name: "Arugula (demo)",
      seedName: "Arugula",
      germinationDays: 7,
      fertigationDays: 14,
      organizationId,
    })
    .returning();
  const [p5] = await tx
    .insert(growthProfilesTable)
    .values({
      name: "Microgreen Mix (demo)",
      seedName: "Microgreen Mix",
      germinationDays: 3,
      fertigationDays: 7,
      organizationId,
    })
    .returning();

  // 2. seed_lots — qr_code is only unique per (facility_id, qr_code), so the
  //    literal QR codes below are safe to reuse verbatim across every demo
  //    facility (see the footgun note above).
  await tx.insert(seedLotsTable).values([
    { facilityId, qrCode: "QR-SUNFL-001", seedName: "Sunflower" },
    { facilityId, qrCode: "QR-BROCL-001", seedName: "Broccoli" },
    { facilityId, qrCode: "QR-RADSH-001", seedName: "Radish" },
    { facilityId, qrCode: "QR-PEAST-001", seedName: "Pea Shoots" },
    { facilityId, qrCode: "QR-MICRO-001", seedName: "Microgreen Mix" },
    { facilityId, qrCode: "QR-WHEAT-001", seedName: "Wheatgrass" },
  ]);

  // 3. cycles (d001-d010, same lifecycle spread as the CLI's seed):
  //      3 fresh germination, 2 germination (1 overdue), 2 fertigation
  //      (1 overdue), 3 completed. short_id is suffixed with facilityId —
  //      see the footgun note above; growthProfileId points at the p1/p5
  //      rows just created for THIS org, not a hardcoded id.
  const overdueGermDaysAgo = p5.germinationDays + 4; // past p5.germinationDays (3) → overdue
  const overdueFertDaysAgo = p5.fertigationDays + 5; // past p5.fertigationDays (7) → overdue

  const sid = (n: string) => `d${facilityId}-${n}`;

  await tx.insert(cyclesTable).values([
    {
      shortId: sid("001"),
      seedLotQrCodes: ["LOT-SEED-001"],
      seedName: "Sunflower",
      fullTrays: 4,
      halfTrays: 1,
      seedWeightTray: "150",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(1)),
      status: "germination",
      trayPosition: "RACK-A1",
      germinationStartedAt: daysAgo(1),
      createdAt: daysAgo(1),
      facilityId,
    },
    {
      shortId: sid("002"),
      seedLotQrCodes: ["LOT-SEED-002"],
      seedName: "Broccoli",
      fullTrays: 6,
      halfTrays: 0,
      seedWeightTray: "120",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(2)),
      status: "germination",
      trayPosition: "RACK-B3",
      germinationStartedAt: daysAgo(2),
      createdAt: daysAgo(2),
      facilityId,
    },
    {
      shortId: sid("003"),
      seedLotQrCodes: ["LOT-SEED-003"],
      seedName: "Radish",
      fullTrays: 3,
      halfTrays: 2,
      seedWeightTray: "90",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(3)),
      status: "germination",
      trayPosition: "RACK-C2",
      germinationStartedAt: daysAgo(3),
      createdAt: daysAgo(3),
      facilityId,
    },
    {
      shortId: sid("004"),
      seedLotQrCodes: ["LOT-GERM-001"],
      seedName: "Pea Shoots",
      fullTrays: 8,
      halfTrays: 0,
      seedWeightTray: "200",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(5)),
      status: "germination",
      trayPosition: "RACK-D4",
      germinationStartedAt: daysAgo(5), // 5 days < p1.germinationDays (7) → not overdue
      createdAt: daysAgo(5),
      facilityId,
    },
    {
      shortId: sid("005"),
      seedLotQrCodes: ["LOT-GERM-002"],
      seedName: "Microgreen Mix",
      fullTrays: 5,
      halfTrays: 1,
      seedWeightTray: "110",
      growthProfileId: p5.id,
      seedingDate: isoDate(daysAgo(overdueGermDaysAgo)),
      status: "germination",
      trayPosition: "RACK-E1",
      germinationStartedAt: daysAgo(overdueGermDaysAgo), // overdue
      createdAt: daysAgo(overdueGermDaysAgo),
      facilityId,
    },
    {
      shortId: sid("006"),
      seedLotQrCodes: ["LOT-FERT-001"],
      seedName: "Wheatgrass",
      fullTrays: 10,
      halfTrays: 2,
      seedWeightTray: "180",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(12)),
      status: "fertigation",
      trayPosition: "RACK-F2",
      germinationStartedAt: daysAgo(12),
      fertigationStartedAt: daysAgo(5), // 5 days < p1.fertigationDays (14) → not overdue
      createdAt: daysAgo(12),
      facilityId,
    },
    {
      shortId: sid("007"),
      seedLotQrCodes: ["LOT-FERT-002"],
      seedName: "Microgreen Mix",
      fullTrays: 4,
      halfTrays: 0,
      seedWeightTray: "95",
      growthProfileId: p5.id,
      seedingDate: isoDate(daysAgo(overdueFertDaysAgo + 5)),
      status: "fertigation",
      trayPosition: "RACK-G3",
      germinationStartedAt: daysAgo(overdueFertDaysAgo + 5),
      fertigationStartedAt: daysAgo(overdueFertDaysAgo), // overdue
      createdAt: daysAgo(overdueFertDaysAgo + 5),
      facilityId,
    },
    {
      shortId: sid("008"),
      seedLotQrCodes: ["LOT-COMP-001"],
      seedName: "Lentil",
      fullTrays: 6,
      halfTrays: 2,
      seedWeightTray: "140",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(17)),
      status: "completed",
      trayPosition: "RACK-H1",
      germinationStartedAt: daysAgo(17),
      fertigationStartedAt: daysAgo(13),
      harvestStartedAt: daysAgo(5),
      harvestedQty: "3200",
      closedAt: daysAgo(5),
      createdAt: daysAgo(17),
      facilityId,
    },
    {
      shortId: sid("009"),
      seedLotQrCodes: ["LOT-COMP-002"],
      seedName: "Sunflower",
      fullTrays: 8,
      halfTrays: 0,
      seedWeightTray: "160",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(28)),
      status: "completed",
      trayPosition: "RACK-A4",
      germinationStartedAt: daysAgo(28),
      fertigationStartedAt: daysAgo(24),
      harvestStartedAt: daysAgo(16),
      harvestedQty: "4800",
      closedAt: daysAgo(16),
      createdAt: daysAgo(28),
      facilityId,
    },
    {
      shortId: sid("010"),
      seedLotQrCodes: ["LOT-COMP-003"],
      seedName: "Broccoli",
      fullTrays: 5,
      halfTrays: 1,
      seedWeightTray: "125",
      growthProfileId: p1.id,
      seedingDate: isoDate(daysAgo(30)),
      status: "completed",
      trayPosition: "RACK-B2",
      germinationStartedAt: daysAgo(30),
      fertigationStartedAt: daysAgo(26),
      harvestStartedAt: daysAgo(20),
      harvestedQty: "2750",
      closedAt: daysAgo(20),
      createdAt: daysAgo(30),
      facilityId,
    },
  ]);

  // 4. sensors (facilityWide: true satisfies the placement CHECK — no room/
  //    rack/channel required) + a handful of recent sensor_readings each.
  const [tempSensor, humiditySensor] = await tx
    .insert(sensorsTable)
    .values([
      { facilityId, type: "temp", label: "Facility Temp (demo)", unit: "°C", facilityWide: true },
      { facilityId, type: "humidity", label: "Facility Humidity (demo)", unit: "%", facilityWide: true },
    ])
    .returning({ id: sensorsTable.id });

  await tx.insert(sensorReadingsTable).values([
    { sensorId: tempSensor!.id, metric: "temp", value: "21.4", readAt: daysAgo(0) },
    { sensorId: tempSensor!.id, metric: "temp", value: "21.8", readAt: daysAgo(1) },
    { sensorId: tempSensor!.id, metric: "temp", value: "20.9", readAt: daysAgo(2) },
    { sensorId: humiditySensor!.id, metric: "humidity", value: "58.0", readAt: daysAgo(0) },
    { sensorId: humiditySensor!.id, metric: "humidity", value: "60.5", readAt: daysAgo(1) },
    { sensorId: humiditySensor!.id, metric: "humidity", value: "57.2", readAt: daysAgo(2) },
  ]);

  // 5. alerts — 2 rows (1 current, 1 resolved). The current row's location
  //    is suffixed with facilityId to keep the (title, location) pair unique
  //    across every demo org's provision — see the footgun note above.
  await tx.insert(alertsTable).values([
    {
      title: "Low EC in Zone 1",
      description: "EC reading has drifted below the target range.",
      location: `Zone 1 (Facility ${facilityId})`,
      severity: "warning",
      status: "current",
      facilityId,
    },
    {
      title: "Sensor offline (resolved)",
      description: "Humidity sensor briefly lost connection.",
      location: "Zone 2",
      severity: "critical",
      status: "resolved",
      resolvedAt: daysAgo(2),
      facilityId,
    },
  ]);

  // 6. tasks — 2 rows.
  await tx.insert(tasksTable).values([
    { type: "inspect", status: "pending", assignee: "Demo Technician", dueAt: daysAgo(-1), facilityId },
    { type: "harvest", status: "done", assignee: "Demo Technician", completedAt: daysAgo(3), facilityId },
  ]);

  // 7. inventory_items — 3 rows; currentQty <= maxQty (CHECK).
  await tx.insert(inventoryItemsTable).values([
    { name: "Arugula Seed (demo)", brand: "Demo Seed Co", category: "seed", currentQty: "1200", maxQty: "5000", unit: "g", facilityId },
    { name: "Nutrient Solution A (demo)", brand: "Demo Nutrients", category: "nutrient", currentQty: "8", maxQty: "20", unit: "L", facilityId },
    { name: "Growing Trays (demo)", brand: "Demo Supply", category: "hardware", currentQty: "40", maxQty: "60", unit: "unit", facilityId },
  ]);

  // 8. facility_logs — 3 recent rows. userId is NOT NULL, threaded from ctx.
  await tx.insert(facilityLogsTable).values([
    { logType: "env_check", userId, data: { temp: 21.4, humidity: 58 }, notes: "Routine environment check.", createdAt: daysAgo(0), facilityId },
    { logType: "maintenance", userId, data: { item: "Fertigation pump" }, notes: "Cleaned pump filter.", createdAt: daysAgo(1), facilityId },
    { logType: "receiving", userId, data: { item: "Arugula seed", qtyKg: 5 }, notes: "Received new seed shipment.", createdAt: daysAgo(4), facilityId },
  ]);
}
