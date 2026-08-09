import { describe, test, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

/**
 * GET /demo/status, POST /demo/provision, POST /demo/graduate (TEN-013 Tasks
 * 6-7). Every test seeds its own org via a random UUID user, so — like
 * seedDemoOrg.test.ts and wizard.test.ts's cross-org cases — the shared,
 * never-truncated `organizations`/`facilities`/`organization_members` tables
 * never need resetting between tests: every assertion is scoped to the
 * organizationId/facilityId the test itself created.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("GET/POST /api/demo/*", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["organizations", "facilities", "cycles", "seed_lots", "sensors", "sensor_readings", "alerts", "tasks", "inventory_items", "facility_logs", "growth_profiles", "users", "organization_members"]);

  const origFlag = process.env.DEMO_FORK_ENABLED;
  afterEach(() => {
    if (origFlag === undefined) delete process.env.DEMO_FORK_ENABLED;
    else process.env.DEMO_FORK_ENABLED = origFlag;
  });

  /**
   * Seeds an active OWNER membership for a brand-new org with NO facility —
   * the real fork's actual pre-condition (TEN-012's ensureOwnerOrg has run,
   * W2's POST /facilities has not). Deliberately not seedTenantContext (which
   * always creates a facility too).
   */
  async function seedOwnerOrgNoFacility(): Promise<{ userId: string; organizationId: number }> {
    const { usersTable, organizationsTable, organizationMembersTable } = await import("@workspace/db");
    const userId = randomUUID();
    await seedTestUser(fixture.db, usersTable, { id: userId, email: `demo-test-${userId}@ten013-test.example.com` });
    const adb = getAdminDb() ?? fixture.db;
    const [org] = await adb.insert(organizationsTable).values({ name: `Demo Test Org ${userId}` }).returning();
    await adb.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId,
      role: "owner",
      status: "active",
    });
    return { userId, organizationId: org.id };
  }

  async function buildApp(userId: string, mountFacilities = false) {
    const demoModule = await import("../../routes/demo");
    if (!mountFacilities) {
      return createAuthenticatedTestApp(demoModule.default, { sub: userId });
    }
    const facilitiesModule = await import("../../routes/facilities");
    const { Router } = await import("express");
    const combinedRouter = Router();
    combinedRouter.use(demoModule.default);
    combinedRouter.use(facilitiesModule.default);
    return createAuthenticatedTestApp(combinedRouter, { sub: userId });
  }

  describe("POST /api/demo/provision", () => {
    test("flag off: 403, writes nothing", async () => {
      delete process.env.DEMO_FORK_ENABLED;
      const { userId, organizationId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId);

      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 403);

      const { organizationsTable, facilitiesTable } = await import("@workspace/db");
      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      strictEqual(org.isDemo, false);
      const facilities = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      strictEqual(facilities.length, 0);
    });

    test("flag on, fresh owner org: provisions, seeds, marks the demo facility onboarded", async () => {
      process.env.DEMO_FORK_ENABLED = "true";
      const { userId, organizationId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId, true);

      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 200);
      const facilityId = res.body.facilityId as number;
      ok(facilityId > 0);

      const { organizationsTable, facilitiesTable, cyclesTable, seedLotsTable } = await import("@workspace/db");
      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      strictEqual(org.isDemo, true);

      const facilities = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      strictEqual(facilities.length, 1, "exactly one facility for a fresh provision");

      const cycles = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));
      ok(cycles.length > 0, "cycles should have been seeded");
      const seedLots = await fixture.db.select().from(seedLotsTable).where(eq(seedLotsTable.facilityId, facilityId));
      ok(seedLots.length > 0, "seed_lots should have been seeded");

      const statusRes = await request(app).get("/api/demo/status");
      strictEqual(statusRes.status, 200);
      strictEqual(statusRes.body.enabled, true);
      strictEqual(statusRes.body.isDemo, true);
      strictEqual(statusRes.body.demoFacilityId, facilityId);

      // Design decision (per Task 6): provision also stamps a wizard_progress
      // row at currentStep:"done" for the demo facility, so GET /facilities'
      // own onboarded-derivation (routes/facilities.ts: wizard_progress rows
      // with currentStep==="done") reports it onboarded — landing the demo
      // user directly on the dashboard, not back in the wizard.
      const facilitiesListRes = await request(app).get("/api/facilities");
      strictEqual(facilitiesListRes.status, 200);
      const demoFacility = facilitiesListRes.body.find((f: { id: number }) => f.id === facilityId);
      ok(demoFacility, "demo facility should appear in GET /facilities");
      strictEqual(demoFacility.onboarded, true, "the demo facility must report onboarded:true");
    });

    test("second provision is idempotent: same facilityId, no duplicate facility, no re-seed", async () => {
      process.env.DEMO_FORK_ENABLED = "true";
      const { userId, organizationId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId);

      const first = await request(app).post("/api/demo/provision").send({});
      strictEqual(first.status, 200);
      const facilityId = first.body.facilityId as number;

      const { facilitiesTable, cyclesTable } = await import("@workspace/db");
      const cyclesAfterFirst = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));

      const second = await request(app).post("/api/demo/provision").send({});
      strictEqual(second.status, 200);
      strictEqual(second.body.facilityId, facilityId);

      const facilities = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      strictEqual(facilities.length, 1, "no duplicate facility on a second provision");
      const cyclesAfterSecond = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));
      strictEqual(cyclesAfterSecond.length, cyclesAfterFirst.length, "no re-seed on a second provision");
    });

    test("no active owner membership: 403", async () => {
      process.env.DEMO_FORK_ENABLED = "true";
      const { usersTable } = await import("@workspace/db");
      const userId = randomUUID();
      await seedTestUser(fixture.db, usersTable, { id: userId, email: `demo-no-org-${userId}@ten013-test.example.com` });
      const app = await buildApp(userId);

      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 403);
    });

    test("non-owner (technician) active membership: 403", async () => {
      process.env.DEMO_FORK_ENABLED = "true";
      const { usersTable, organizationsTable, organizationMembersTable } = await import("@workspace/db");
      const userId = randomUUID();
      await seedTestUser(fixture.db, usersTable, { id: userId, email: `demo-technician-${userId}@ten013-test.example.com` });
      const adb = getAdminDb() ?? fixture.db;
      const [org] = await adb.insert(organizationsTable).values({ name: `Technician Org ${userId}` }).returning();
      await adb.insert(organizationMembersTable).values({
        organizationId: org.id,
        userId,
        role: "technician",
        status: "active",
      });
      const app = await buildApp(userId);

      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 403);
    });
  });

  describe("POST /api/demo/graduate", () => {
    async function provisionDemo() {
      process.env.DEMO_FORK_ENABLED = "true";
      const { userId, organizationId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId);
      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 200);
      return { app, userId, organizationId, facilityId: res.body.facilityId as number };
    }

    test("graduates a demo org: deletes the facility + cascaded rows, cleans demo growth profiles, org+membership survive", async () => {
      const { app, organizationId, facilityId } = await provisionDemo();

      const res = await request(app).post("/api/demo/graduate").send({ confirm: true });
      strictEqual(res.status, 200);

      const {
        organizationsTable,
        organizationMembersTable,
        facilitiesTable,
        cyclesTable,
        seedLotsTable,
        sensorsTable,
        facilityLogsTable,
        growthProfilesTable,
      } = await import("@workspace/db");

      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      ok(org, "the organization row itself must survive graduate");
      strictEqual(org.isDemo, false);

      const [membership] = await fixture.db
        .select()
        .from(organizationMembersTable)
        .where(and(eq(organizationMembersTable.organizationId, organizationId), eq(organizationMembersTable.role, "owner")));
      ok(membership, "the owner membership must survive graduate");
      strictEqual(membership.status, "active");

      const facilities = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      strictEqual(facilities.length, 0, "the demo facility must be gone");

      const cycles = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, facilityId));
      strictEqual(cycles.length, 0, "cycles must cascade away");
      const seedLots = await fixture.db.select().from(seedLotsTable).where(eq(seedLotsTable.facilityId, facilityId));
      strictEqual(seedLots.length, 0, "seed_lots must cascade away");
      const sensors = await fixture.db.select().from(sensorsTable).where(eq(sensorsTable.facilityId, facilityId));
      strictEqual(sensors.length, 0, "sensors must cascade away");
      const facilityLogs = await fixture.db.select().from(facilityLogsTable).where(eq(facilityLogsTable.facilityId, facilityId));
      strictEqual(facilityLogs.length, 0, "facility_logs must cascade away");

      const growthProfiles = await fixture.db
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.organizationId, organizationId));
      strictEqual(growthProfiles.length, 0, "the demo growth profiles are explicitly removed on graduate");
    });

    test("second graduate is a safe no-op", async () => {
      const { app, organizationId } = await provisionDemo();
      await request(app).post("/api/demo/graduate").send({ confirm: true });

      const res = await request(app).post("/api/demo/graduate").send({ confirm: true });
      strictEqual(res.status, 200);

      const { organizationsTable } = await import("@workspace/db");
      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      strictEqual(org.isDemo, false);
    });

    test("confirm:false: 400, no state change", async () => {
      const { app, organizationId, facilityId } = await provisionDemo();

      const res = await request(app).post("/api/demo/graduate").send({ confirm: false });
      strictEqual(res.status, 400);

      const { organizationsTable, facilitiesTable } = await import("@workspace/db");
      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      strictEqual(org.isDemo, true, "graduate must not run without an explicit confirm:true");
      const [facility] = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.id, facilityId));
      ok(facility, "the demo facility must still exist");
    });
  });

  describe("Cross-tenant isolation (TEN-013 Task 11)", () => {
    test("user B's GET /demo/status never reflects org A's isDemo/demo facility", async () => {
      process.env.DEMO_FORK_ENABLED = "true";

      // Provision org A as a demo
      const { userId: userA, organizationId: orgAId } = await seedOwnerOrgNoFacility();
      const appA = await buildApp(userA);
      const provisionRes = await request(appA).post("/api/demo/provision").send({});
      strictEqual(provisionRes.status, 200);
      const demoFacilityA = provisionRes.body.facilityId as number;

      // Seed org B as a separate owner org
      const { userId: userB, organizationId: orgBId } = await seedOwnerOrgNoFacility();
      const appB = await buildApp(userB);

      // B's status should show their own org (not demo, no facility)
      const bStatusRes = await request(appB).get("/api/demo/status");
      strictEqual(bStatusRes.status, 200);
      strictEqual(bStatusRes.body.enabled, true);
      strictEqual(bStatusRes.body.isDemo, false, "org B's status must not reflect org A's demo state");
      strictEqual(bStatusRes.body.demoFacilityId, null, "org B must not see org A's demo facility");

      // Verify A's status still shows demo
      const aStatusRes = await request(appA).get("/api/demo/status");
      strictEqual(aStatusRes.status, 200);
      strictEqual(aStatusRes.body.isDemo, true);
      strictEqual(aStatusRes.body.demoFacilityId, demoFacilityA);
    });

    test("after org A provisions, org B's POST /demo/graduate leaves A's demo facility and cascaded rows fully intact", async () => {
      process.env.DEMO_FORK_ENABLED = "true";

      // Provision org A as a demo
      const { userId: userA, organizationId: orgAId } = await seedOwnerOrgNoFacility();
      const appA = await buildApp(userA);
      const provisionRes = await request(appA).post("/api/demo/provision").send({});
      strictEqual(provisionRes.status, 200);
      const demoFacilityA = provisionRes.body.facilityId as number;

      // Verify A has seeded data
      const { cyclesTable, seedLotsTable, sensorsTable, facilityLogsTable } = await import("@workspace/db");
      const cyclesBeforeB = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, demoFacilityA));
      ok(cyclesBeforeB.length > 0, "org A's facility should have seeded cycles");

      // Seed org B
      const { userId: userB, organizationId: orgBId } = await seedOwnerOrgNoFacility();
      const appB = await buildApp(userB);

      // B attempts to graduate (which should be a no-op, since B is not a demo org)
      const graduateRes = await request(appB).post("/api/demo/graduate").send({ confirm: true });
      strictEqual(graduateRes.status, 200, "graduate must succeed even when not a demo org (idempotent)");

      // Assert A's demo facility and ALL its cascaded rows are fully intact
      const cyclesAfterB = await fixture.db.select().from(cyclesTable).where(eq(cyclesTable.facilityId, demoFacilityA));
      strictEqual(cyclesAfterB.length, cyclesBeforeB.length, "org A's cycles must not be affected by org B's graduate");

      const seedLotsAfterB = await fixture.db.select().from(seedLotsTable).where(eq(seedLotsTable.facilityId, demoFacilityA));
      ok(seedLotsAfterB.length > 0, "org A's seed_lots must still exist");

      const sensorsAfterB = await fixture.db.select().from(sensorsTable).where(eq(sensorsTable.facilityId, demoFacilityA));
      ok(sensorsAfterB.length > 0, "org A's sensors must still exist");

      const logsAfterB = await fixture.db.select().from(facilityLogsTable).where(eq(facilityLogsTable.facilityId, demoFacilityA));
      ok(logsAfterB.length > 0, "org A's facility_logs must still exist");

      // Verify A is still a demo org
      const { organizationsTable } = await import("@workspace/db");
      const [orgA] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, orgAId));
      strictEqual(orgA.isDemo, true, "org A must still be marked as demo after org B's graduate");
    });

    test("RLS regression: UPDATE organizations SET is_demo with wrong app.org_id affects 0 rows", async () => {
      // This test directly exercises the RLS UPDATE policy (Task 2) by attempting
      // to flip org A's is_demo with B's app.org_id set, proving the policy denies
      // the write. The policy is the regression canary for the GUC-set-before-write
      // ordering if it ever drifts.
      const { db, organizationsTable } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");

      // Provision org A
      process.env.DEMO_FORK_ENABLED = "true";
      const { userId: userA, organizationId: orgAId } = await seedOwnerOrgNoFacility();
      const appA = await buildApp(userA);
      const provisionRes = await request(appA).post("/api/demo/provision").send({});
      strictEqual(provisionRes.status, 200);

      // Seed org B
      const { userId: userB, organizationId: orgBId } = await seedOwnerOrgNoFacility();

      // Attempt to update org A's is_demo with B's app.org_id set
      const updateRowCount = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.org_id', ${orgBId.toString()}, true)`);
        const updateResult = await tx
          .update(organizationsTable)
          .set({ isDemo: false })
          .where(eq(organizationsTable.id, orgAId));
        // Drizzle's update returns an object; we need to check if rows were affected
        // by re-reading the org to confirm is_demo was NOT flipped
        return updateResult;
      });

      // Re-read org A as a superuser to confirm is_demo was NOT changed
      const adb = getAdminDb() ?? fixture.db;
      const [orgA] = await adb.select().from(organizationsTable).where(eq(organizationsTable.id, orgAId));
      strictEqual(orgA.isDemo, true, "org A's is_demo must remain true after failed RLS UPDATE (RLS policy must deny the write)");
    });
  });

  describe("Flag-off regression (TEN-013 Task 11)", () => {
    test("with DEMO_FORK_ENABLED unset: POST /demo/provision → 403, no rows written", async () => {
      delete process.env.DEMO_FORK_ENABLED;
      const { userId, organizationId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId);

      const res = await request(app).post("/api/demo/provision").send({});
      strictEqual(res.status, 403);

      // Verify no demo facility was created
      const { organizationsTable, facilitiesTable } = await import("@workspace/db");
      const [org] = await fixture.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
      strictEqual(org.isDemo, false, "is_demo must not be set when flag is off");
      const facilities = await fixture.db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      strictEqual(facilities.length, 0, "no facility should be created when flag is off");
    });

    test("with DEMO_FORK_ENABLED unset: GET /demo/status → enabled:false", async () => {
      delete process.env.DEMO_FORK_ENABLED;
      const { userId } = await seedOwnerOrgNoFacility();
      const app = await buildApp(userId);

      const res = await request(app).get("/api/demo/status");
      strictEqual(res.status, 200);
      strictEqual(res.body.enabled, false, "enabled must be false when flag is unset");
    });
  });
});
