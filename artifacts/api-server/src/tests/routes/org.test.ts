// artifacts/api-server/src/tests/routes/org.test.ts
import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

/**
 * GET /api/org/summary (TEN-009 Task 1). Every test seeds its own org via a
 * random UUID user, so — like demo.test.ts / seedDemoOrg.test.ts — the
 * shared, never-truncated `organizations`/`facilities`/`organization_members`
 * tables never need resetting between tests: every assertion is scoped to the
 * organizationId/facilityId the test itself created.
 *
 * Runs under the real farmsmart_app role (TEST_DATABASE_URL, see
 * testDatabase.ts) — org.ts's own withTenantScope loop is what's under test,
 * so a BYPASSRLS connection here would make the facility-GUC RLS a silent
 * no-op and give false confidence (per AGENTS.md's isolation-proof mandate).
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("GET /api/org/summary (TEN-009)", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture([]);

  async function buildApp(userId: string) {
    const orgModule = await import("../../routes/org");
    return createAuthenticatedTestApp(orgModule.default, { sub: userId });
  }

  /**
   * Seeds an active membership (given role) for a brand-new org with NO
   * facility yet.
   */
  async function seedOrgMembership(role: "owner" | "admin" | "technician"): Promise<{
    userId: string;
    organizationId: number;
  }> {
    const { usersTable, organizationsTable, organizationMembersTable } = await import("@workspace/db");
    const userId = randomUUID();
    await seedTestUser(fixture.db, usersTable, { id: userId, email: `org-test-${userId}@ten009-test.example.com` });
    const adb = getAdminDb() ?? fixture.db;
    const [org] = await adb.insert(organizationsTable).values({ name: `Org Summary Test Org ${userId}` }).returning();
    await adb.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId,
      role,
      status: "active",
    });
    return { userId, organizationId: org.id };
  }

  /**
   * Seeds a facility directly (admin connection, bypassing RLS — this is
   * fixture setup, not exercising the route under test, same pattern as
   * cross-tenant.test.ts's direct growthProfiles/seedLots/channels inserts)
   * plus `activeCycleCount` non-completed cycles and `openAlertCount`
   * current-status alerts on it. Returns the facility id.
   */
  async function seedFacilityWithData(
    organizationId: number,
    activeCycleCount: number,
    openAlertCount: number,
  ): Promise<number> {
    const { facilitiesTable, growthProfilesTable, cyclesTable, alertsTable } = await import("@workspace/db");
    const adb = getAdminDb() ?? fixture.db;

    const [facility] = await adb
      .insert(facilitiesTable)
      .values({
        name: `Facility ${randomUUID()}`,
        organizationId,
        facilityName: `Facility ${randomUUID()}`,
        timezone: "UTC",
        units: "metric",
        currency: "USD",
      })
      .returning();

    const [growthProfile] = await adb
      .insert(growthProfilesTable)
      .values({
        name: `Org Summary Test Crop ${randomUUID()}`,
        seedName: "Test Seed",
        germinationDays: 1,
        fertigationDays: 1,
        organizationId,
      })
      .returning();

    for (let i = 0; i < activeCycleCount; i++) {
      await adb.insert(cyclesTable).values({
        shortId: `ORG-TEST-ACTIVE-${randomUUID()}`,
        seedLotQrCodes: ["ORG-TEST-QR"],
        seedName: "Test Seed",
        fullTrays: 1,
        halfTrays: 0,
        seedWeightTray: "5",
        growthProfileId: growthProfile.id,
        seedingDate: new Date().toISOString().slice(0, 10),
        status: "germination",
        facilityId: facility.id,
      });
    }
    // One completed cycle per facility with data — proves the "active" filter
    // (status <> 'completed') actually excludes it, not just that it counts
    // whatever exists.
    if (activeCycleCount > 0) {
      await adb.insert(cyclesTable).values({
        shortId: `ORG-TEST-COMPLETED-${randomUUID()}`,
        seedLotQrCodes: ["ORG-TEST-QR"],
        seedName: "Test Seed",
        fullTrays: 1,
        halfTrays: 0,
        seedWeightTray: "5",
        growthProfileId: growthProfile.id,
        seedingDate: new Date().toISOString().slice(0, 10),
        status: "completed",
        facilityId: facility.id,
      });
    }

    for (let i = 0; i < openAlertCount; i++) {
      await adb.insert(alertsTable).values({
        title: `Org Summary Test Alert ${randomUUID()}`,
        severity: "warning",
        status: "current",
        facilityId: facility.id,
      });
    }
    // One resolved alert per facility with data — proves the "open" filter
    // (status = 'current') actually excludes it.
    if (openAlertCount > 0) {
      await adb.insert(alertsTable).values({
        title: `Org Summary Test Resolved Alert ${randomUUID()}`,
        severity: "warning",
        status: "resolved",
        facilityId: facility.id,
      });
    }

    return facility.id;
  }

  test("owner of A: 200, correct facilityCount + A-only activeCycles/openAlerts sums, never counts org B", async () => {
    const { userId: userA, organizationId: orgAId } = await seedOrgMembership("owner");
    await seedFacilityWithData(orgAId, 2, 1); // facility 1: 2 active cycles, 1 open alert
    await seedFacilityWithData(orgAId, 3, 2); // facility 2: 3 active cycles, 2 open alerts

    // Org B: separate org with its own (larger) data set, to prove org A's
    // summary never includes it.
    const { organizationId: orgBId } = await seedOrgMembership("owner");
    await seedFacilityWithData(orgBId, 10, 10);

    const appA = await buildApp(userA);
    const res = await request(appA).get("/api/org/summary");
    strictEqual(res.status, 200);
    strictEqual(res.body.facilityCount, 2);
    strictEqual(res.body.activeCycles, 5, "org A's active cycles must be 2+3=5, never including org B's 10");
    strictEqual(res.body.openAlerts, 3, "org A's open alerts must be 1+2=3, never including org B's 10");
  });

  test("admin of A: 200 (owner/admin gate admits admin too)", async () => {
    const { userId, organizationId } = await seedOrgMembership("admin");
    await seedFacilityWithData(organizationId, 1, 1);

    const app = await buildApp(userId);
    const res = await request(app).get("/api/org/summary");
    strictEqual(res.status, 200);
    strictEqual(res.body.facilityCount, 1);
    strictEqual(res.body.activeCycles, 1);
    strictEqual(res.body.openAlerts, 1);
  });

  test("technician (non-owner-admin) member: 403", async () => {
    const { userId } = await seedOrgMembership("technician");
    const app = await buildApp(userId);

    const res = await request(app).get("/api/org/summary");
    strictEqual(res.status, 403);
    strictEqual(res.body.code, "ROLE_FORBIDDEN");
  });

  test("no active membership: 403", async () => {
    const { usersTable } = await import("@workspace/db");
    const userId = randomUUID();
    await seedTestUser(fixture.db, usersTable, { id: userId, email: `org-no-org-${userId}@ten009-test.example.com` });
    const app = await buildApp(userId);

    const res = await request(app).get("/api/org/summary");
    strictEqual(res.status, 403);
  });

  test("zero-facility org: 200 { facilityCount: 0, activeCycles: 0, openAlerts: 0 }", async () => {
    const { userId } = await seedOrgMembership("owner");
    const app = await buildApp(userId);

    const res = await request(app).get("/api/org/summary");
    strictEqual(res.status, 200);
    strictEqual(res.body.facilityCount, 0);
    strictEqual(res.body.activeCycles, 0);
    strictEqual(res.body.openAlerts, 0);
  });
});
