import { describe, test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("POST /api/sensors/bulk", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["sensors", "channels", "rooms", "facilities", "organizations"]);

  async function setup() {
    const sensors = await import("../../routes/sensors");
    const { db, organizationsTable, facilitiesTable, roomsTable, channelsTable } = await import("@workspace/db");
    const [org] = await db.insert(organizationsTable).values({ name: "Test Org" }).returning();
    const [facility] = await db.insert(facilitiesTable).values({
      name: "Test Farm", organizationId: org.id, facilityName: "Test Farm",
      timezone: "UTC", units: "metric", currency: "USD",
    }).returning();
    const [room] = await db.insert(roomsTable).values({ name: "seeding", facilityId: facility.id }).returning();
    const channels = await db.insert(channelsTable).values([
      { roomId: room.id, label: "C1" }, { roomId: room.id, label: "C2" }, { roomId: room.id, label: "C3" },
    ]).returning();
    return { app: createAuthenticatedTestApp(sensors.default), channelIds: channels.map((c) => c.id) };
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
