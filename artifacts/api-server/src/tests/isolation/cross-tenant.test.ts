// artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
import { Router } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  seedTestUser,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";
import facilitiesRouter from "../../routes/facilities";
import alertsRouter from "../../routes/alerts";
import tasksRouter from "../../routes/tasks";
import shipmentsRouter from "../../routes/shipments";
import inventoryRouter from "../../routes/inventory";
import growthProfilesRouter from "../../routes/growthProfiles";
import metricsRouter from "../../routes/metrics";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

const combinedRouter = Router();
combinedRouter.use(facilitiesRouter);
combinedRouter.use(alertsRouter);
combinedRouter.use(tasksRouter);
combinedRouter.use(shipmentsRouter);
combinedRouter.use(inventoryRouter);
combinedRouter.use(growthProfilesRouter);
combinedRouter.use(metricsRouter);

// Every table this milestone scopes, plus the bootstrap tables the two orgs
// themselves are created into -- a full-suite truncate is safe here (this is
// the ONLY test file in the isolation/ directory, no cross-file pollution
// risk per MT-M0's Task 13 finding).
const FIXTURE_TABLES =
  "organizations, facilities, rooms, users, organization_members, " +
  "cycles, inventory_items, alerts, tasks, shipments, " +
  "facility_logs, sensors, growth_profiles, seed_lots, " +
  "manual_checks, bad_tray_entries";

describe("Cross-tenant isolation (TEN-007)", { skip: !dbUrl }, () => {
  let orgA: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number };
  let orgB: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number };
  let seededAlertId: number;
  let seededTaskId: number;
  let seededShipmentId: number;
  let seededInventoryItemId: number;
  let seededGrowthProfileId: number;

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;
    const { db, usersTable } = await import("@workspace/db");

    // ONE truncate for the whole suite, not per-test: this suite seeds org
    // A/B and their resources ONCE here, then reads/asserts against that
    // same data across many tests below. useDatabaseFixture's beforeEach
    // (re-truncating before EVERY test) would wipe this seeded data out
    // between test cases -- caught for real running this exact suite: every
    // test after the first found orgA/orgB's own facilities/rooms/
    // memberships gone, since beforeEach nuked them right before each test
    // ran.
    await (getAdminDb() ?? db).execute(
      (await import("drizzle-orm")).sql.raw(`TRUNCATE ${FIXTURE_TABLES} RESTART IDENTITY CASCADE`),
    );

    async function provisionOrg(email: string) {
      const userId = randomUUID();
      await seedTestUser(db, usersTable, { id: userId, email });
      const testApp = createAuthenticatedTestApp(combinedRouter, { sub: userId });
      const createRes = await request(testApp)
        .post("/api/facilities")
        .send({ farmName: `Org for ${email}`, timezone: "UTC", units: "metric", currency: "USD" });
      strictEqual(createRes.status, 201, `facility creation for ${email} must succeed`);
      return { app: testApp, facilityId: createRes.body.facilityId as number };
    }

    orgA = await provisionOrg("org-a@isolation-test.example.com");
    orgB = await provisionOrg("org-b@isolation-test.example.com");

    // Org A's own growth profile -- MT-M1's own audit (Task 7's design)
    // found no per-org auto-seed exists (growthProfiles.ts's seedDataIfEmpty
    // is a one-time pilot bootstrap, not a per-org mechanism); each test org
    // needs its own row inserted directly.
    const { growthProfilesTable, facilitiesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [orgAFacility] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, orgA.facilityId));
    const [gp] = await (getAdminDb() ?? db)
      .insert(growthProfilesTable)
      .values({
        name: "Isolation Test Crop",
        seedName: "Test Seed",
        germinationDays: 1,
        fertigationDays: 1,
        organizationId: orgAFacility!.organizationId,
      })
      .returning();
    seededGrowthProfileId = gp.id;

    const alertRes = await request(orgA.app).post("/api/alerts").send({ title: "Org A alert", severity: "warning" });
    seededAlertId = alertRes.body.id;

    const taskRes = await request(orgA.app).post("/api/tasks").send({ type: "harvest" });
    seededTaskId = taskRes.body.id;

    const shipmentRes = await request(orgA.app).post("/api/shipments").send({ client: "Org A Client" });
    seededShipmentId = shipmentRes.body.id;

    const inventoryRes = await request(orgA.app).post("/api/inventory").send({ name: "Org A Item" });
    seededInventoryItemId = inventoryRes.body.id;
  });

  test("TEN-003: two facilities each independently hold a seeding room (no cross-facility conflict)", async () => {
    const { db, roomsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [roomA] = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, orgA.facilityId));
    const [roomB] = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, orgB.facilityId));
    ok(roomA, "org A must have its own rooms");
    ok(roomB, "org B must have its own rooms");
  });

  test("GET /alerts: org B never sees org A's alert", async () => {
    const res = await request(orgB.app).get("/api/alerts");
    strictEqual(res.status, 200);
    ok(!res.body.some((a: { id: number }) => a.id === seededAlertId), "org B's alert list must not contain org A's alert");
  });

  test("PATCH /alerts/:id: org B gets 404 for org A's alert id, not 403 or 200", async () => {
    const res = await request(orgB.app).patch(`/api/alerts/${seededAlertId}`).send({ status: "resolved" });
    strictEqual(res.status, 404);
  });

  test("GET /tasks: org B never sees org A's task", async () => {
    const res = await request(orgB.app).get("/api/tasks");
    strictEqual(res.status, 200);
    ok(!res.body.some((t: { id: number }) => t.id === seededTaskId));
  });

  test("PATCH /tasks/:id: org B gets 404 for org A's task id", async () => {
    const res = await request(orgB.app).patch(`/api/tasks/${seededTaskId}`).send({ status: "done" });
    strictEqual(res.status, 404);
  });

  test("GET /shipments: org B never sees org A's shipment", async () => {
    const res = await request(orgB.app).get("/api/shipments");
    strictEqual(res.status, 200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    ok(!items.some((s: { id: number }) => s.id === seededShipmentId));
  });

  test("DELETE /shipments/:id: org B gets 404 for org A's shipment id", async () => {
    const res = await request(orgB.app).delete(`/api/shipments/${seededShipmentId}`);
    strictEqual(res.status, 404);
  });

  test("GET /inventory: org B never sees org A's item", async () => {
    const res = await request(orgB.app).get("/api/inventory");
    strictEqual(res.status, 200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    ok(!items.some((i: { id: number }) => i.id === seededInventoryItemId));
  });

  test("PATCH /inventory/:id: org B gets 404 for org A's item id", async () => {
    const res = await request(orgB.app).patch(`/api/inventory/${seededInventoryItemId}`).send({ currentQty: 5 });
    strictEqual(res.status, 404);
  });

  test("GET /growth-profiles: org B never sees org A's growth profile", async () => {
    const res = await request(orgB.app).get("/api/growth-profiles");
    strictEqual(res.status, 200);
    ok(!res.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));
  });

  test("GET /api/metrics: org B's dashboard totals never include org A's data", async () => {
    const resA = await request(orgA.app).get("/api/metrics").query({ tab: "overview", keys: "ov.tasks.open" });
    const resB = await request(orgB.app).get("/api/metrics").query({ tab: "overview", keys: "ov.tasks.open" });
    strictEqual(resA.status, 200);
    strictEqual(resB.status, 200);
    // Org A seeded one open task; org B seeded none -- if metrics leaked
    // cross-tenant, org B's count would be >= 1 too.
    strictEqual(resB.body["ov.tasks.open"].value, 0);
    ok(resA.body["ov.tasks.open"].value >= 1);
  });
});
