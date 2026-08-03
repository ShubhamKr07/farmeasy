import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * GET /seed-lots/lookup (Task 6: per-facility qr_code scoping).
 *
 * seed_lots.qr_code is no longer globally unique — it is unique per facility
 * (composite UNIQUE(facility_id, qr_code) added in 0023). The two tests below
 * guard the new contract:
 *   1. Two seed lots with the SAME qr_code in two DIFFERENT facilities both
 *      insert cleanly (would have thrown a unique-violation under the old
 *      global-unique constraint).
 *   2. GET /seed-lots/lookup?qrCode=X, which scopes to the pilot-default
 *      facility (lowest id), must never leak Facility B's row back through a
 *      Facility A query even when both rows share that qr_code.
 *
 * Gated on TEST_DATABASE_URL, mirroring facility-readiness.test.ts /
 * sensor-accounts.test.ts: the router and `@workspace/db` are imported lazily
 * inside setup() so this file loads (and skips cleanly) when no test database
 * is configured.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("seed_lots per-facility qr_code scoping", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["seed_lots", "facilities", "organizations"]);

  async function setup() {
    const seedLots = await import("../../routes/seedLots");
    const { db, organizationsTable, facilitiesTable, seedLotsTable } = await import(
      "@workspace/db"
    );

    const [org] = await db
      .insert(organizationsTable)
      .values({ name: "Sunrise Greens" })
      .returning();

    // Insert Facility A BEFORE Facility B so A has the lower serial id — the
    // lookup handler resolves the pilot-default facility via
    // `SELECT id FROM facilities ORDER BY id LIMIT 1`, so A is what the
    // lookup scopes to. TRUNCATE ... RESTART IDENTITY in the fixture makes
    // this ordering deterministic across tests.
    const [facilityA] = await db
      .insert(facilitiesTable)
      .values({
        name: "Sunrise Greens",
        organizationId: org.id,
        facilityName: "Sunrise Greens",
        timezone: "UTC",
        units: "metric",
        currency: "USD",
      })
      .returning();
    const [facilityB] = await db
      .insert(facilitiesTable)
      .values({
        name: "North Field",
        organizationId: org.id,
        facilityName: "North Field",
        timezone: "UTC",
        units: "metric",
        currency: "USD",
      })
      .returning();

    return {
      app: createAuthenticatedTestApp(seedLots.default),
      db,
      seedLotsTable,
      facilityA,
      facilityB,
    };
  }

  test("the same qr_code can exist in two different facilities (no global conflict)", async () => {
    const { db, seedLotsTable, facilityA, facilityB } = await setup();
    const sharedQrCode = "SHARED-QR-001";

    const [lotA] = await db
      .insert(seedLotsTable)
      .values({ facilityId: facilityA.id, qrCode: sharedQrCode, seedName: "Radish A" })
      .returning();
    const [lotB] = await db
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

    await db
      .insert(seedLotsTable)
      .values({ facilityId: facilityA.id, qrCode: sharedQrCode, seedName: "Radish A" })
      .returning();
    await db
      .insert(seedLotsTable)
      .values({ facilityId: facilityB.id, qrCode: sharedQrCode, seedName: "Radish B" })
      .returning();

    // The lookup scopes to the pilot-default facility (lowest id = A), so it
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
