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
  // Only `seed_lots` is truncated. `facilities`/`organizations` are shared
  // reference tables the FK graph now fans out through (TRUNCATE ... CASCADE
  // would destroy every cycles/inventory_items/alerts/tasks/shipments/...
  // row). This means we can no longer manufacture "the lowest facility id in
  // the table" by truncating first — some other suite's pilot-default
  // facility may already exist with a lower id than anything we insert here.
  // Instead: resolve the CURRENT lowest-id facility (whatever it is — the
  // same query the lookup handler itself runs) and use THAT as facility A,
  // rather than assuming a freshly-inserted row will win the id race.
  // Facility B is a brand-new insert, guaranteed a higher (serial) id than
  // any pre-existing row. This makes the test's premise (lookup resolves to
  // the lowest-id facility, and must never leak facility B's row) hold
  // regardless of what other suites have already created.
  const fixture = useDatabaseFixture(["seed_lots"]);

  async function setup() {
    const seedLots = await import("../../routes/seedLots");
    const { db, organizationsTable, facilitiesTable, seedLotsTable } = await import(
      "@workspace/db"
    );

    const [facilityA] = await db
      .select()
      .from(facilitiesTable)
      .orderBy(facilitiesTable.id)
      .limit(1);
    ok(facilityA, "expected at least one pre-existing facility (seeded by migrations)");

    const [org] = await db
      .insert(organizationsTable)
      .values({ name: "North Field Org" })
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
    ok(facilityB.id > facilityA.id, "facility B must get a strictly higher id than facility A");

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
