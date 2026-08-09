import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import { sql, eq, inArray } from "drizzle-orm";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase.js";

/**
 * seedDemoOrg (TEN-013 Task 4) — asserts the shared demo dataset seeds every
 * facility-scoped table it claims to (cascade audit in
 * lib/db/src/seed/seedDemoOrg.ts), NEVER writes to the two ON DELETE RESTRICT
 * children of cycles (manual_checks, bad_tray_entries — either would make the
 * demo facility undeletable), and that deleting the facility tears the whole
 * seeded graph down to zero rows via ON DELETE CASCADE (the mechanism
 * POST /demo/graduate relies on).
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("seedDemoOrg", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture([
    "seed_lots",
    "cycles",
    "sensors",
    "sensor_readings",
    "alerts",
    "tasks",
    "inventory_items",
    "facility_logs",
    "growth_profiles",
    "manual_checks",
    "bad_tray_entries",
  ]);

  test("seeds every facility/org-scoped table, writes nothing restrict-blocking, and cascades cleanly on facility delete", async () => {
    const {
      seedDemoOrg,
      usersTable,
      organizationsTable,
      facilitiesTable,
      organizationMembersTable,
      seedLotsTable,
      cyclesTable,
      sensorsTable,
      sensorReadingsTable,
      alertsTable,
      tasksTable,
      inventoryItemsTable,
      facilityLogsTable,
      growthProfilesTable,
      manualChecksTable,
      badTrayEntriesTable,
    } = await import("@workspace/db");

    const ownerId = randomUUID();
    const { organizationId, facilityId } = await seedTenantContext(
      fixture.db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: ownerId, email: `seed-demo-org-${ownerId}@ten013-test.example.com` },
      { memberRole: "owner" },
    );

    await fixture.db.transaction(async (tx: typeof fixture.db) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${facilityId.toString()}, true)`);
      await seedDemoOrg(tx, { organizationId, facilityId, userId: ownerId });
    });

    const admin = getAdminDb() ?? fixture.db;

    const seedLots = await admin.select().from(seedLotsTable).where(eq(seedLotsTable.facilityId, facilityId));
    ok(seedLots.length > 0, "seed_lots should have been seeded");

    const cycles = await admin.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));
    ok(cycles.length > 0, "cycles should have been seeded");

    const sensors = await admin.select().from(sensorsTable).where(eq(sensorsTable.facilityId, facilityId));
    ok(sensors.length > 0, "sensors should have been seeded");
    const sensorIds = sensors.map((s: { id: number }) => s.id);

    const sensorReadings = await admin
      .select()
      .from(sensorReadingsTable)
      .where(inArray(sensorReadingsTable.sensorId, sensorIds));
    ok(sensorReadings.length > 0, "sensor_readings should have been seeded");

    const alerts = await admin.select().from(alertsTable).where(eq(alertsTable.facilityId, facilityId));
    ok(alerts.length > 0, "alerts should have been seeded");

    const tasks = await admin.select().from(tasksTable).where(eq(tasksTable.facilityId, facilityId));
    ok(tasks.length > 0, "tasks should have been seeded");

    const inventoryItems = await admin
      .select()
      .from(inventoryItemsTable)
      .where(eq(inventoryItemsTable.facilityId, facilityId));
    ok(inventoryItems.length > 0, "inventory_items should have been seeded");

    const facilityLogs = await admin
      .select()
      .from(facilityLogsTable)
      .where(eq(facilityLogsTable.facilityId, facilityId));
    ok(facilityLogs.length > 0, "facility_logs should have been seeded");

    const growthProfiles = await admin
      .select()
      .from(growthProfilesTable)
      .where(eq(growthProfilesTable.organizationId, organizationId));
    strictEqual(growthProfiles.length, 2, "exactly 2 org-scoped growth profiles");

    // Cascade-safety guard: seedDemoOrg must NEVER write to these two ON
    // DELETE RESTRICT children of cycles — a single row in either would block
    // the facility delete below (and POST /demo/graduate in production).
    const cycleIds = cycles.map((c: { id: number }) => c.id);
    const manualChecks = cycleIds.length
      ? await admin.select().from(manualChecksTable).where(inArray(manualChecksTable.cycleId, cycleIds))
      : [];
    strictEqual(manualChecks.length, 0, "seedDemoOrg must never write manual_checks (restrict child of cycles)");
    const badTrayEntries = cycleIds.length
      ? await admin.select().from(badTrayEntriesTable).where(inArray(badTrayEntriesTable.cycleId, cycleIds))
      : [];
    strictEqual(badTrayEntries.length, 0, "seedDemoOrg must never write bad_tray_entries (restrict child of cycles)");

    // Cascade teardown proof: deleting the facility must succeed (no FK
    // error from a restrict-child row) and take every seeded facility-scoped
    // table down to zero rows.
    await admin.delete(facilitiesTable).where(eq(facilitiesTable.id, facilityId));

    const seedLotsAfter = await admin.select().from(seedLotsTable).where(eq(seedLotsTable.facilityId, facilityId));
    strictEqual(seedLotsAfter.length, 0);
    const cyclesAfter = await admin.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));
    strictEqual(cyclesAfter.length, 0);
    const sensorsAfter = await admin.select().from(sensorsTable).where(eq(sensorsTable.facilityId, facilityId));
    strictEqual(sensorsAfter.length, 0);
    const sensorReadingsAfter = await admin
      .select()
      .from(sensorReadingsTable)
      .where(inArray(sensorReadingsTable.sensorId, sensorIds));
    strictEqual(sensorReadingsAfter.length, 0);
    const alertsAfter = await admin.select().from(alertsTable).where(eq(alertsTable.facilityId, facilityId));
    strictEqual(alertsAfter.length, 0);
    const tasksAfter = await admin.select().from(tasksTable).where(eq(tasksTable.facilityId, facilityId));
    strictEqual(tasksAfter.length, 0);
    const inventoryItemsAfter = await admin
      .select()
      .from(inventoryItemsTable)
      .where(eq(inventoryItemsTable.facilityId, facilityId));
    strictEqual(inventoryItemsAfter.length, 0);
    const facilityLogsAfter = await admin
      .select()
      .from(facilityLogsTable)
      .where(eq(facilityLogsTable.facilityId, facilityId));
    strictEqual(facilityLogsAfter.length, 0);
  });
});
