import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

/**
 * GET /seed-lots/lookup (Task 6: per-facility qr_code scoping; Task 8:
 * tenant-scoped via withTenantScope + req.tenant.facilityId).
 *
 * seed_lots.qr_code is no longer globally unique — it is unique per facility
 * (composite UNIQUE(facility_id, qr_code) added in 0023). The two tests below
 * guard the new contract:
 *   1. Two seed lots with the SAME qr_code in two DIFFERENT facilities both
 *      insert cleanly (would have thrown a unique-violation under the old
 *      global-unique constraint).
 *   2. GET /seed-lots/lookup?qrCode=X, which now scopes to the requesting
 *      user's facility (req.tenant.facilityId, resolved by
 *      resolveTenantContext from the seeded organization_members row), must
 *      never leak Facility B's row back through a Facility A query even when
 *      both rows share that qr_code.
 *
 * Gated on TEST_DATABASE_URL, mirroring facility-readiness.test.ts /
 * sensor-accounts.test.ts: the router and `@workspace/db` are imported lazily
 * inside setup() so this file loads (and skips cleanly) when no test database
 * is configured.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("seed_lots per-facility qr_code scoping", { skip: !dbUrl }, () => {
  // Only `seed_lots` is truncated. `facilities`/`organizations`/
  // `organization_members` are shared reference tables the FK graph now fans
  // out through (TRUNCATE ... CASCADE would destroy every
  // cycles/inventory_items/alerts/tasks/shipments/... row). Each setup()
  // therefore seeds its OWN fresh tenant context (org + facility + membership)
  // for the test user via seedTenantContext, and asserts key off the RETURNED
  // facilityId rather than off the tables being globally empty. The
  // organization_members.user_id unique index means a repeated call for the
  // same userId (e.g. across the two tests) upserts the membership onto the
  // new org/facility — never a duplicate, never a stale-facility leak.
  const fixture = useDatabaseFixture(["seed_lots"]);

  async function setup() {
    const seedLots = await import("../../routes/seedLots");
    const {
      db,
      usersTable,
      organizationsTable,
      facilitiesTable,
      organizationMembersTable,
      seedLotsTable,
    } = await import("@workspace/db");

    // Seed a real tenant membership for the test user. This is exactly what
    // resolveTenantContext (mounted by createAuthenticatedTestApp) joins on to
    // populate req.tenant { organizationId, facilityId, role }, which the
    // rewired lookup handler scopes by. The returned facilityId is Facility A
    // — the facility the lookup must resolve to.
    const { facilityId: facilityAId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
    );

    // Facility B is a separate facility (different org) so the same qr_code can
    // coexist in two facilities under the composite UNIQUE(facility_id,
    // qr_code) without colliding. Its rows must never surface through a
    // Facility A-scoped lookup.
    const [orgB] = await db
      .insert(organizationsTable)
      .values({ name: "North Field Org" })
      .returning();
    const [facilityB] = await db
      .insert(facilitiesTable)
      .values({
        name: "North Field",
        organizationId: orgB.id,
        facilityName: "North Field",
        timezone: "UTC",
        units: "metric",
        currency: "USD",
      })
      .returning();
    ok(facilityB.id !== facilityAId, "facility B must be distinct from facility A");

    return {
      app: createAuthenticatedTestApp(seedLots.default),
      db,
      seedLotsTable,
      facilityA: { id: facilityAId },
      facilityB,
    };
  }

  test("the same qr_code can exist in two different facilities (no global conflict)", async () => {
    const { db, seedLotsTable, facilityA, facilityB } = await setup();
    const sharedQrCode = "SHARED-QR-001";

    const [lotA] = await (getAdminDb() ?? db)
      .insert(seedLotsTable)
      .values({ facilityId: facilityA.id, qrCode: sharedQrCode, seedName: "Radish A" })
      .returning();
    const [lotB] = await (getAdminDb() ?? db)
      .insert(seedLotsTable)
      .values({ facilityId: facilityB.id, qrCode: sharedQrCode, seedName: "Radish B" })
      .returning();

    // Both inserts succeeded (no unique-violation thrown) and each row lives
    // in its own facility — the composite UNIQUE(facility_id, qr_code)
    // permits this, where the old global-unique constraint would not.
    ok(lotA, "lot A insert should return a row");
    ok(lotB, "lot B insert should return a row");
    strictEqual(lotA.qrCode, sharedQrCode);
    strictEqual(lotB.qrCode, sharedQrCode);
    strictEqual(lotA.facilityId, facilityA.id);
    strictEqual(lotB.facilityId, facilityB.id);
    ok(lotA.id !== lotB.id, "the two lots must be distinct rows");
  });

  test("GET /seed-lots/lookup never returns another facility's row for the same qr_code", async () => {
    const { app, db, seedLotsTable, facilityA, facilityB } = await setup();
    const sharedQrCode = "SHARED-QR-002";

    await (getAdminDb() ?? db)
      .insert(seedLotsTable)
      .values({ facilityId: facilityA.id, qrCode: sharedQrCode, seedName: "Radish A" })
      .returning();
    await (getAdminDb() ?? db)
      .insert(seedLotsTable)
      .values({ facilityId: facilityB.id, qrCode: sharedQrCode, seedName: "Radish B" })
      .returning();

    // The lookup scopes to the requesting user's facility (req.tenant.
    // facilityId = Facility A, resolved from the seeded membership), so it
    // must resolve to Facility A's row and never Facility B's, even though
    // both rows share this qr_code.
    const res = await request(app)
      .get("/api/seed-lots/lookup")
      .query({ qrCode: sharedQrCode });
    strictEqual(res.status, 200);
    strictEqual(res.body.qrCode, sharedQrCode);
    strictEqual(res.body.facilityId, facilityA.id);
    strictEqual(res.body.seedName, "Radish A");
    ok(res.body.seedName !== "Radish B", "must not leak Facility B's row");
  });
});
