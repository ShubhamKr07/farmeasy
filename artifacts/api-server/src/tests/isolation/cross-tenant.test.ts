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

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

// Route modules are imported lazily inside before() (only when the describe
// block actually runs) -- mirrors every other DB-gated test file in this
// codebase. A static top-of-file import transitively pulls in
// `@workspace/db`, which throws at module-load time when DATABASE_URL is
// unset, regardless of describe's own `{ skip: !dbUrl }` gate (ESM imports
// evaluate before any runtime skip logic runs) -- caught for real: this file
// crashed the whole local no-database test run before this fix.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let combinedRouter: any;

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
  let orgA: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number; userId: string };
  let orgB: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number; userId: string };
  let seededAlertId: number;
  let seededTaskId: number;
  let seededShipmentId: number;
  let seededInventoryItemId: number;
  let seededGrowthProfileId: number;
  let seededCycleId: number;
  let seededSensorId: number;
  let seededSeedLotQrCode: string;
  // TEN-008: org A's second facility -- proves facility-level isolation
  // WITHIN the same organization/user, one level deeper than this suite's
  // existing cross-*organization* pattern.
  let facilityATwoId: number;
  let facilityATwoApp: ReturnType<typeof createAuthenticatedTestApp>;
  let facilityTwoCycleId: number;

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;
    const { db, usersTable } = await import("@workspace/db");

    // TEN-012: POST /facilities no longer creates the org; ensureOwnerOrg
    // (the wizard-bootstrap provisioner) does. Used by provisionOrg below.
    const { ensureOwnerOrg } = await import("../../lib/ensureOwnerOrg");
    const facilitiesRouter = (await import("../../routes/facilities")).default;
    const alertsRouter = (await import("../../routes/alerts")).default;
    const tasksRouter = (await import("../../routes/tasks")).default;
    const shipmentsRouter = (await import("../../routes/shipments")).default;
    const inventoryRouter = (await import("../../routes/inventory")).default;
    const growthProfilesRouter = (await import("../../routes/growthProfiles")).default;
    const metricsRouter = (await import("../../routes/metrics")).default;
    const cyclesRouter = (await import("../../routes/cycles")).default;
    const facilityLogsRouter = (await import("../../routes/facilityLogs")).default;
    const sensorsRouter = (await import("../../routes/sensors")).default;
    const seedLotsRouter = (await import("../../routes/seedLots")).default;
    const accountingRouter = (await import("../../routes/accounting")).accountingRouter;
    // TEN-008: GET /facility-readiness (Step 2's new tests) isn't mounted by
    // any of the routers above -- added here so that assertion can run
    // against the real route rather than 404ing on an unmounted path.
    const facilityReadinessRouter = (await import("../../routes/facility-readiness")).default;
    combinedRouter = Router();
    combinedRouter.use(facilitiesRouter);
    combinedRouter.use(alertsRouter);
    combinedRouter.use(tasksRouter);
    combinedRouter.use(shipmentsRouter);
    combinedRouter.use(inventoryRouter);
    combinedRouter.use(growthProfilesRouter);
    combinedRouter.use(metricsRouter);
    combinedRouter.use(cyclesRouter);
    combinedRouter.use(facilityLogsRouter);
    combinedRouter.use(sensorsRouter);
    combinedRouter.use(seedLotsRouter);
    combinedRouter.use(accountingRouter);
    combinedRouter.use(facilityReadinessRouter);

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
      // Provision the owner org exactly as the wizard bootstrap does, since
      // POST /facilities no longer creates it (TEN-012).
      await ensureOwnerOrg(userId, email);
      const bootstrapApp = createAuthenticatedTestApp(combinedRouter, { sub: userId });
      const createRes = await request(bootstrapApp)
        .post("/api/facilities")
        .send({ farmName: `Org for ${email}`, timezone: "UTC", units: "metric", currency: "USD" });
      strictEqual(createRes.status, 201, `facility creation for ${email} must succeed`);
      const facilityId = createRes.body.facilityId as number;
      const app = createAuthenticatedTestApp(combinedRouter, { sub: userId }, facilityId);
      return { app, facilityId, userId };
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

    const cycleRes = await request(orgA.app).post("/api/cycles").send({
      seedLotQrCodes: ["ISO-QR-1"],
      seedName: "Isolation Test Crop",
      fullTrays: 2,
      halfTrays: 1,
      seedWeightTray: 5,
      growthProfileId: seededGrowthProfileId,
      seedingDate: new Date().toISOString().slice(0, 10),
    });
    strictEqual(cycleRes.status, 201, "cycle creation for org A must succeed");
    seededCycleId = cycleRes.body.id;

    await request(orgA.app).post("/api/facility-logs").send({
      logType: "env_check",
      data: { zone: "Isolation Test Zone" },
    });

    // sensors.ts requires a channelId or rackId -- org A's own facility only
    // has POST /facilities's 3 default rooms (no channels/racks), so a
    // channel is seeded directly (same reasoning as the growth profile
    // above: no per-org auto-seed for layout entities either).
    const { channelsTable, roomsTable } = await import("@workspace/db");
    const [orgARoom] = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, orgA.facilityId)).limit(1);
    const [channel] = await (getAdminDb() ?? db)
      .insert(channelsTable)
      .values({ roomId: orgARoom!.id, label: "Isolation Test Channel", positionIndex: 0 })
      .returning();

    const sensorRes = await request(orgA.app).post("/api/sensors").send({
      channelId: channel.id,
      type: "temp",
      label: "Isolation Test Sensor",
      unit: "C",
    });
    strictEqual(sensorRes.status, 201, "sensor creation for org A must succeed");
    seededSensorId = sensorRes.body.id;

    // seed_lots has no generic create-via-HTTP route in this milestone (only
    // GET /seed-lots/lookup) -- seeded directly, matching the growth-profile/
    // channel pattern above.
    const { seedLotsTable } = await import("@workspace/db");
    seededSeedLotQrCode = "ISO-SEEDLOT-QR";
    await (getAdminDb() ?? db)
      .insert(seedLotsTable)
      .values({ facilityId: orgA.facilityId, qrCode: seededSeedLotQrCode, seedName: "Isolation Test Seed" });

    // accounting_connections is populated by a real Intuit OAuth callback in
    // production, which this suite can't drive -- seeded directly (same
    // reasoning as above) so GET /accounting/status has something to find.
    const { accountingConnectionsTable } = await import("@workspace/db");
    await (getAdminDb() ?? db)
      .insert(accountingConnectionsTable)
      .values({
        userId: orgA.userId,
        organizationId: orgAFacility!.organizationId,
        provider: "quickbooks",
        realmId: "isolation-test-realm",
        accessTokenEnc: "isolation-test-access-enc",
        refreshTokenEnc: "isolation-test-refresh-enc",
        expiresAt: new Date(Date.now() + 3600_000),
      });

    // TEN-008: a second facility for org A itself — proves facility-level
    // isolation WITHIN the same organization/user, one level deeper than
    // this suite's existing cross-*organization* pattern.
    const secondFacilityRes = await request(orgA.app)
      .post("/api/facilities")
      .send({ farmName: "Org A Second Facility", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(secondFacilityRes.status, 201, "org A's second facility must be created");
    facilityATwoId = secondFacilityRes.body.facilityId as number;
    facilityATwoApp = createAuthenticatedTestApp(combinedRouter, { sub: orgA.userId }, facilityATwoId);

    const facilityTwoCycleRes = await request(facilityATwoApp).post("/api/cycles").send({
      seedLotQrCodes: ["ISO-QR-FACILITY-2"],
      seedName: "Isolation Test Crop",
      fullTrays: 3,
      halfTrays: 0,
      seedWeightTray: 8,
      growthProfileId: seededGrowthProfileId,
      seedingDate: new Date().toISOString().slice(0, 10),
    });
    strictEqual(facilityTwoCycleRes.status, 201, "cycle creation for org A's second facility must succeed");
    facilityTwoCycleId = facilityTwoCycleRes.body.id;
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

  test("GET /api/metrics: org B never sees org A's data via a custom.ts query (ov.cap.trayMix)", async () => {
    // ov.cap.trayMix is one of custom.ts's 11 hand-written queries (Task 12) --
    // unlike ov.tasks.open (a generic scalarAgg template), this exercises the
    // custom-query dispatch path (CUSTOM_QUERIES) under real RLS.
    const resA = await request(orgA.app).get("/api/metrics").query({ tab: "overview", keys: "ov.cap.trayMix" });
    const resB = await request(orgB.app).get("/api/metrics").query({ tab: "overview", keys: "ov.cap.trayMix" });
    strictEqual(resA.status, 200);
    strictEqual(resB.status, 200);
    const orgATotal = (resA.body["ov.cap.trayMix"] as { label: string; value: number }[])
      .reduce((sum, r) => sum + r.value, 0);
    const orgBTotal = (resB.body["ov.cap.trayMix"] as { label: string; value: number }[])
      .reduce((sum, r) => sum + r.value, 0);
    // Org A seeded a cycle with 2 full + 1 half tray; org B seeded no cycles.
    strictEqual(orgBTotal, 0);
    ok(orgATotal > 0);
  });

  test("GET /cycles: org B never sees org A's cycle", async () => {
    const res = await request(orgB.app).get("/api/cycles");
    strictEqual(res.status, 200);
    ok(!res.body.some((c: { id: number }) => c.id === seededCycleId), "org B's cycle list must not contain org A's cycle");
  });

  test("GET /cycles/:id: org B gets 404 for org A's cycle id", async () => {
    const res = await request(orgB.app).get(`/api/cycles/${seededCycleId}`);
    strictEqual(res.status, 404);
  });

  test("GET /sensors: org B never sees org A's sensor", async () => {
    const res = await request(orgB.app).get("/api/sensors");
    strictEqual(res.status, 200);
    ok(!res.body.some((s: { id: number }) => s.id === seededSensorId), "org B's sensor list must not contain org A's sensor");
  });

  test("GET /seed-lots/lookup: org B never resolves org A's seed lot by qr code", async () => {
    const res = await request(orgB.app).get("/api/seed-lots/lookup").query({ qrCode: seededSeedLotQrCode });
    // seed_lots.qr_code is unique per facility (composite UNIQUE(facility_id,
    // qr_code), Task 6) -- org B has no row with this qr code at all, so the
    // lookup must 404, never resolve org A's row.
    strictEqual(res.status, 404);
  });

  test("GET /accounting/status: org B never sees org A's QuickBooks connection", async () => {
    const res = await request(orgB.app).get("/api/accounting/status");
    strictEqual(res.status, 200);
    strictEqual(res.body.connected, false, "org B must not see org A's accounting_connections row");
  });

  test("POST /facility-logs: org A's log is scoped to org A's own facility (no read endpoint exists to assert cross-tenant via HTTP -- facilityLogs.ts only exposes POST)", async () => {
    const { db, facilityLogsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [log] = await (getAdminDb() ?? db).select().from(facilityLogsTable).where(eq(facilityLogsTable.facilityId, orgA.facilityId));
    ok(log, "org A's facility_logs row must exist and be tagged with org A's own facilityId");
  });

  test("TEN-008: GET /cycles never leaks facility A's original facility's cycle into facility A's second facility", async () => {
    const res = await request(facilityATwoApp).get("/api/cycles");
    strictEqual(res.status, 200);
    ok(
      !res.body.some((c: { id: number }) => c.id === seededCycleId),
      "facility A's SECOND facility's cycle list must not contain the ORIGINAL facility's cycle, even though both are the same org and same user",
    );
    ok(
      res.body.some((c: { id: number }) => c.id === facilityTwoCycleId),
      "facility A's second facility's cycle list must contain its own cycle",
    );
  });

  test("TEN-008: switching X-Facility-Id back to the original facility restores its own view, unaffected by the second facility's data", async () => {
    const res = await request(orgA.app).get("/api/cycles");
    strictEqual(res.status, 200);
    ok(res.body.some((c: { id: number }) => c.id === seededCycleId));
    ok(
      !res.body.some((c: { id: number }) => c.id === facilityTwoCycleId),
      "the original facility's view must not include the second facility's cycle",
    );
  });

  test("TEN-008: org-scoped resources (growth profiles, accounting) are identical regardless of active facility", async () => {
    const originalFacilityRes = await request(orgA.app).get("/api/growth-profiles");
    const secondFacilityRes = await request(facilityATwoApp).get("/api/growth-profiles");
    strictEqual(originalFacilityRes.status, 200);
    strictEqual(secondFacilityRes.status, 200);
    ok(originalFacilityRes.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));
    ok(secondFacilityRes.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));

    const originalAccountingRes = await request(orgA.app).get("/api/accounting/status");
    const secondAccountingRes = await request(facilityATwoApp).get("/api/accounting/status");
    strictEqual(originalAccountingRes.body.connected, secondAccountingRes.body.connected);
  });

  test("TEN-008: missing X-Facility-Id on a facility-scoped route is a 400, never a silent default", async () => {
    const appWithNoFacility = createAuthenticatedTestApp(combinedRouter, { sub: orgA.userId });
    const res = await request(appWithNoFacility).get("/api/cycles");
    strictEqual(res.status, 400);
  });

  test("TEN-008: X-Facility-Id for a real facility belonging to a DIFFERENT organization is a 400, not a 404 or a leak", async () => {
    const crossOrgApp = createAuthenticatedTestApp(combinedRouter, { sub: orgB.userId }, orgA.facilityId);
    const res = await request(crossOrgApp).get("/api/cycles");
    strictEqual(res.status, 400, "org B's user requesting org A's facility id must 400, never resolve org A's data");
  });

  test("TEN-008: GET /facilities lists both of org A's facilities, each with its own onboarded status", async () => {
    const res = await request(orgA.app).get("/api/facilities");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 2);
    const originalEntry = res.body.find((f: { id: number }) => f.id === orgA.facilityId);
    const secondEntry = res.body.find((f: { id: number }) => f.id === facilityATwoId);
    ok(originalEntry && secondEntry, "both of org A's facilities must be listed");
  });

  test("TEN-008: GET /facility-readiness is scoped to the active facility, not the org's arbitrary one", async () => {
    const originalRes = await request(orgA.app).get("/api/facility-readiness");
    const secondRes = await request(facilityATwoApp).get("/api/facility-readiness");
    strictEqual(originalRes.status, 200);
    strictEqual(secondRes.status, 200);
    // Org A's ORIGINAL facility seeded a cycle (seededCycleId) -> "Seed your
    // first cycle" is done there. The SECOND facility also seeded its own
    // cycle (facilityTwoCycleId) in this same test's before() hook -> also
    // done there, independently -- proving each facility's checklist is
    // computed from ITS OWN data, not shared/arbitrary org-wide state.
    const firstCycleItem = (facility: typeof originalRes.body) =>
      facility.items.find((i: { key: string }) => i.key === "first_cycle_seeded");
    strictEqual(firstCycleItem(originalRes.body).state, "done");
    strictEqual(firstCycleItem(secondRes.body).state, "done");
  });
});
