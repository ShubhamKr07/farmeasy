import { describe, test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("POST /api/sensors/bulk", { skip: !dbUrl }, () => {
  // Only `sensors`/`channels`/`rooms` are truncated. `facilities`/
  // `organizations` are shared reference tables the FK graph now fans out
  // through (TRUNCATE ... CASCADE would destroy every cycles/inventory_items/
  // alerts/tasks/shipments/... row plus the pilot-default facility other
  // suites resolve via `ORDER BY id LIMIT 1`). This test creates its own
  // fresh org+facility+room+channels every setup() and every assertion is
  // scoped to the returned `channelIds` — never off these tables being
  // globally empty.
  const fixture = useDatabaseFixture(["sensors", "channels", "rooms"]);

  async function setup() {
    const sensors = await import("../../routes/sensors");
    const {
      db,
      usersTable,
      organizationsTable,
      facilitiesTable,
      organizationMembersTable,
      roomsTable,
      channelsTable,
    } = await import("@workspace/db");
    const { facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
      { farmName: "Test Farm", facilityName: "Test Farm" },
    );
    const [room] = await db.insert(roomsTable).values({ name: "seeding", facilityId }).returning();
    const channels = await db.insert(channelsTable).values([
      { roomId: room.id, label: "C1" }, { roomId: room.id, label: "C2" }, { roomId: room.id, label: "C3" },
    ]).returning();
    return { app: createAuthenticatedTestApp(sensors.default, DEFAULT_TEST_USER, facilityId), channelIds: channels.map((c) => c.id) };
  }

  test("creates one row per (type × channel) combination", async () => {
    const { app, channelIds } = await setup();
    const res = await request(app)
      .post("/api/sensors/bulk")
      .send({ label: "pH/EC probe", types: ["ph", "ec"], channelIds });

    strictEqual(res.status, 201);
    strictEqual(res.body.created.length, 6); // 2 types × 3 channels
    deepStrictEqual(new Set(res.body.created.map((s: { label: string }) => s.label)), new Set(["pH/EC probe"]));
  });
});
