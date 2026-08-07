// artifacts/api-server/src/tests/routes/cycles-roles.test.ts
import { describe, test } from "node:test";
import { strictEqual, notStrictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  seedTestUser,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * TEN-010 Task 7 review finding: the 3 role gates in cycles.ts (collapsed
 * onto req.tenant.role via isPrivileged = role !== "technician") had NO test
 * coverage, and their 403 copy still referenced the pre-collapse
 * "supervisors" role (now fixed to "admins" alongside this suite).
 *
 * Seeds ONE org+facility with TWO memberships: an owner (privileged) and a
 * technician (restricted) — seedTenantContext creates the org/facility/owner
 * membership, then a second organization_members row is inserted directly
 * for the technician, joined to the SAME organizationId so
 * resolveTenantContext resolves both users against the SAME facilityId (see
 * tenantContext.ts's membership lookup: it joins organization_members to
 * facilities by organizationId, not a per-user facility row).
 */
describe("cycles.ts role gates (TEN-010)", { skip: !requireTestDatabaseUrl() }, () => {
  const fixture = useDatabaseFixture([
    "cycles",
    "manual_checks",
    "growth_profiles",
    "organization_members",
    "facilities",
    "organizations",
  ]);

  async function setup() {
    const cycles = await import("../../routes/cycles");
    const {
      db,
      usersTable,
      organizationsTable,
      facilitiesTable,
      organizationMembersTable,
      growthProfilesTable,
      cyclesTable,
    } = await import("@workspace/db");

    const ownerUserId = randomUUID();
    const technicianUserId = randomUUID();

    const { organizationId, facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: ownerUserId, email: `owner-${ownerUserId}@cycles-roles-test.example.com` },
      { memberRole: "owner" },
    );

    // Second membership, same org+facility (via the org join), different
    // user: a technician. Seeded directly via getAdminDb — no HTTP
    // onboarding route exists to add a second member to an existing org in
    // this suite's scope, matching cross-tenant.test.ts's own
    // direct-insert-for-fixture-data pattern.
    await seedTestUser(db, usersTable, {
      id: technicianUserId,
      email: `technician-${technicianUserId}@cycles-roles-test.example.com`,
    });
    await (getAdminDb() ?? db).insert(organizationMembersTable).values({
      organizationId,
      userId: technicianUserId,
      role: "technician",
      status: "active",
    });

    const [profile] = await (getAdminDb() ?? db)
      .insert(growthProfilesTable)
      .values({
        name: "Roles Test Crop",
        seedName: "Roles Test Seed",
        germinationDays: 3,
        fertigationDays: 5,
        organizationId,
      })
      .returning();

    const [completedCycle] = await (getAdminDb() ?? db)
      .insert(cyclesTable)
      .values({
        shortId: `RC-${randomUUID().slice(0, 8)}`,
        seedLotQrCodes: ["ROLES-TEST-QR"],
        seedName: "Roles Test Crop",
        fullTrays: 2,
        halfTrays: 0,
        seedWeightTray: "5",
        growthProfileId: profile.id,
        seedingDate: "2026-07-01",
        status: "completed",
        closedAt: new Date(),
        facilityId,
      })
      .returning();

    const ownerApp = createAuthenticatedTestApp(cycles.default, { sub: ownerUserId }, facilityId);
    const technicianApp = createAuthenticatedTestApp(cycles.default, { sub: technicianUserId }, facilityId);

    return { ownerApp, technicianApp, facilityId, completedCycleId: completedCycle.id as number };
  }

  test("GET /cycles?status=history: technician gets 403 with the de-staled copy", async () => {
    const { technicianApp } = await setup();
    const res = await request(technicianApp).get("/api/cycles").query({ status: "history" });
    strictEqual(res.status, 403);
    strictEqual(res.body.error, "History access is restricted to admins");
  });

  test("GET /cycles?status=history: owner (privileged) gets 200", async () => {
    const { ownerApp } = await setup();
    const res = await request(ownerApp).get("/api/cycles").query({ status: "history" });
    strictEqual(res.status, 200);
    ok(Array.isArray(res.body));
  });

  test("GET /cycles/:id for a completed cycle: technician gets 403 with the de-staled copy", async () => {
    const { technicianApp, completedCycleId } = await setup();
    const res = await request(technicianApp).get(`/api/cycles/${completedCycleId}`);
    strictEqual(res.status, 403);
    strictEqual(res.body.error, "Access to completed cycle details is restricted to admins");
  });

  test("GET /cycles/:id for a completed cycle: owner (privileged) gets a non-403 response", async () => {
    const { ownerApp, completedCycleId } = await setup();
    const res = await request(ownerApp).get(`/api/cycles/${completedCycleId}`);
    notStrictEqual(res.status, 403);
    strictEqual(res.status, 200);
    strictEqual(res.body.id, completedCycleId);
  });

  // Site 3 (line ~627): GET /cycles/:id/manual-checks gates the same way
  // when the parent cycle is completed. No bad-tray/manual-check rows are
  // needed to exercise the gate itself -- the check runs before the checks
  // are even queried, so an empty manual_checks table is sufficient to
  // assert 403 vs non-403 here.
  test("GET /cycles/:id/manual-checks for a completed cycle: technician gets 403 with the de-staled copy", async () => {
    const { technicianApp, completedCycleId } = await setup();
    const res = await request(technicianApp).get(`/api/cycles/${completedCycleId}/manual-checks`);
    strictEqual(res.status, 403);
    strictEqual(res.body.error, "Access to completed cycle audit log is restricted to admins");
  });

  test("GET /cycles/:id/manual-checks for a completed cycle: owner (privileged) gets a non-403 response", async () => {
    const { ownerApp, completedCycleId } = await setup();
    const res = await request(ownerApp).get(`/api/cycles/${completedCycleId}/manual-checks`);
    notStrictEqual(res.status, 403);
    strictEqual(res.status, 200);
    ok(Array.isArray(res.body));
  });
});
