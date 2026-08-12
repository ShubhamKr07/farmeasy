// artifacts/api-server/src/tests/isolation/sensor-status.test.ts
//
// MT-M2 batch 4: sensor_status facility-scoped RLS + withTenantScope
// rescope of both cycles.ts upserts. Proves, under the real disposable
// stack (real farmsmart_app role when provisioned, structural fallback
// otherwise -- same convention as isolation/crops.test.ts):
//   - org A's cycle write (POST /api/cycles with sensor data) creates a
//     sensor_status row keyed to org A's OWN facility_id, never a shared
//     global row.
//   - org B's cycle write creates its OWN distinct sensor_status row
//     (distinct facility_id), never overwriting/reading org A's values.
//   - org A's real farmsmart_app session never sees org B's sensor_status
//     row (RLS end-state, mirroring crops.test.ts's SET LOCAL ROLE
//     farmsmart_app canary pattern, with a structural fallback when that
//     role isn't provisioned in this DB).
//   - GET /dashboard for org B is unaffected by org A's write (regression
//     sanity for cycles/dashboard -- see the note below on why this is not
//     itself the RLS proof for this table).
//
// Note on why this test reads sensor_status directly rather than through
// GET /dashboard: dashboard.ts's computeDashboardSnapshot does NOT read the
// sensor_status table at all -- its `sensorStatus` response field is
// computed from sensorsTable/sensor_readings (see that file's own comment,
// "flat sensor_status singleton row that was never wired to any actual
// sensor", dating to the Phase 7 mobile redesign). sensorStatusTable has
// zero read call sites anywhere in artifacts/api-server today, so a
// GET-/dashboard-based leak assertion would pass trivially without
// exercising this migration's RLS at all. The isolation proof below targets
// the actual mechanism (facility_id + RLS) directly against the table.
import { describe, test, before } from "node:test";
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from "node:assert";
import { Router } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  seedTenantContext,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let combinedRouter: any;

describe("sensor_status facility isolation (MT-M2 batch 4)", { skip: !dbUrl }, () => {
  let orgA: { app: ReturnType<typeof createAuthenticatedTestApp>; organizationId: number; facilityId: number; userId: string };
  let orgB: { app: ReturnType<typeof createAuthenticatedTestApp>; organizationId: number; facilityId: number; userId: string };
  let orgAGrowthProfileId: number;
  let orgBGrowthProfileId: number;

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;
    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable, growthProfilesTable } =
      await import("@workspace/db");

    const cyclesRouter = (await import("../../routes/cycles")).default;
    const dashboardRouter = (await import("../../routes/dashboard")).default;
    combinedRouter = Router();
    combinedRouter.use(cyclesRouter);
    combinedRouter.use(dashboardRouter);

    // Own-fixture truncate (sensor_status + cycles only -- organizations/
    // facilities/organization_members/users/growth_profiles are shared
    // reference tables other suites may also be using in the same
    // disposable-stack run; this suite creates its own fresh org/facility/
    // growth-profile rows below regardless).
    await (getAdminDb() ?? db).execute(
      (await import("drizzle-orm")).sql.raw(`TRUNCATE sensor_status, cycles RESTART IDENTITY CASCADE`),
    );

    async function provisionOrg(email: string) {
      const userId = randomUUID();
      const { organizationId, facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: userId, email },
        { memberRole: "technician" },
      );
      const app = createAuthenticatedTestApp(combinedRouter, { sub: userId }, facilityId);
      return { app, organizationId, facilityId, userId };
    }

    orgA = await provisionOrg("sensor-status-org-a@isolation-test.example.com");
    orgB = await provisionOrg("sensor-status-org-b@isolation-test.example.com");

    // Each org needs its own growth profile for POST /cycles (no per-org
    // auto-seed exists -- same reasoning as cross-tenant.test.ts).
    const [gpA] = await (getAdminDb() ?? db)
      .insert(growthProfilesTable)
      .values({
        name: "Sensor Status Isolation Crop A",
        seedName: "Test Seed A",
        germinationDays: 1,
        fertigationDays: 1,
        organizationId: orgA.organizationId,
      })
      .returning();
    orgAGrowthProfileId = gpA.id;

    const [gpB] = await (getAdminDb() ?? db)
      .insert(growthProfilesTable)
      .values({
        name: "Sensor Status Isolation Crop B",
        seedName: "Test Seed B",
        germinationDays: 1,
        fertigationDays: 1,
        organizationId: orgB.organizationId,
      })
      .returning();
    orgBGrowthProfileId = gpB.id;
  });

  test("POST /cycles: org A's sensor data creates a sensor_status row keyed to org A's own facility", async () => {
    const res = await request(orgA.app).post("/api/cycles").send({
      seedLotQrCodes: ["SS-ISO-QR-A"],
      seedName: "Sensor Status Isolation Crop A",
      fullTrays: 1,
      halfTrays: 0,
      seedWeightTray: 5,
      growthProfileId: orgAGrowthProfileId,
      seedingDate: new Date().toISOString().slice(0, 10),
      humidity: 55,
      temperature: 21,
      ph: 6.1,
      waterLevel: 80,
      nutrientMix: "Org A Mix",
    });
    strictEqual(res.status, 201, "cycle creation with sensor data for org A must succeed");

    const { db, sensorStatusTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await (getAdminDb() ?? db)
      .select()
      .from(sensorStatusTable)
      .where(eq(sensorStatusTable.facilityId, orgA.facilityId));
    ok(row, "a sensor_status row must exist for org A's facility");
    strictEqual(row!.humidityPct, 55);
    strictEqual(row!.tempCelsius, 21);
    strictEqual(row!.nutrientMix, "Org A Mix");
  });

  test("POST /cycles: org B's sensor data creates its OWN distinct sensor_status row, never overwriting org A's", async () => {
    const res = await request(orgB.app).post("/api/cycles").send({
      seedLotQrCodes: ["SS-ISO-QR-B"],
      seedName: "Sensor Status Isolation Crop B",
      fullTrays: 1,
      halfTrays: 0,
      seedWeightTray: 5,
      growthProfileId: orgBGrowthProfileId,
      seedingDate: new Date().toISOString().slice(0, 10),
      humidity: 40,
      temperature: 18,
      ph: 5.8,
      waterLevel: 60,
      nutrientMix: "Org B Mix",
    });
    strictEqual(res.status, 201, "cycle creation with sensor data for org B must succeed");

    const { db, sensorStatusTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const [rowB] = await (getAdminDb() ?? db)
      .select()
      .from(sensorStatusTable)
      .where(eq(sensorStatusTable.facilityId, orgB.facilityId));
    ok(rowB, "a sensor_status row must exist for org B's facility");
    strictEqual(rowB!.humidityPct, 40);
    strictEqual(rowB!.nutrientMix, "Org B Mix");

    // The previously-written org A row (from the test above) must be
    // completely unchanged -- distinct rows per facility_id, not one
    // shared/overwritten global row.
    const [rowA] = await (getAdminDb() ?? db)
      .select()
      .from(sensorStatusTable)
      .where(eq(sensorStatusTable.facilityId, orgA.facilityId));
    ok(rowA, "org A's sensor_status row must still exist");
    strictEqual(rowA!.humidityPct, 55, "org B's write must never mutate org A's row");
    strictEqual(rowA!.nutrientMix, "Org A Mix", "org B's write must never mutate org A's row");
    notStrictEqual(rowA!.id, rowB!.id, "org A and org B must have distinct sensor_status rows");
    notStrictEqual(rowA!.facilityId, rowB!.facilityId, "org A and org B's rows must key on distinct facility_id values");
  });

  // Mirrors isolation/crops.test.ts's canary pattern: withTenantScope only
  // sets the app.org_id/app.facility_id GUCs, it does not change role, and
  // the disposable-stack `db` connection is the `postgres` superuser
  // (always BYPASSRLS) -- so a raw SELECT through it "succeeds" (returns
  // rows) no matter what the RLS policy says. Skip the LIVE functional deny
  // when farmsmart_app isn't provisioned as a real non-BYPASSRLS role and
  // fall back to the structural proof instead (the policy exists, is scoped
  // to app.facility_id, and carries no current_user clause, matching this
  // batch's role-agnostic design). When farmsmart_app IS provisioned, SET
  // LOCAL ROLE to it inside the transaction and run the real functional
  // check: org A's session, scoped to org A's own facility_id, must never
  // see org B's row.
  test("RLS end-state: org A's real farmsmart_app session never sees org B's sensor_status row", async () => {
    const { db, sensorStatusTable } = await import("@workspace/db");
    const { eq, sql, and, ne } = await import("drizzle-orm");

    const roleCheck = await db.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'farmsmart_app'`,
    );
    const farmsmartAppRow = (roleCheck.rows as { rolbypassrls: boolean }[])[0];
    const hasEnforcingAppRole = farmsmartAppRow !== undefined && farmsmartAppRow.rolbypassrls === false;

    if (!hasEnforcingAppRole) {
      const policyCheck = await db.execute(sql`
        SELECT cmd, coalesce(qual, with_check) AS predicate
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'sensor_status' AND cmd = 'SELECT'
      `);
      const rows = policyCheck.rows as { cmd: string; predicate: string | null }[];
      strictEqual(rows.length, 1, "sensor_status must have exactly one SELECT policy (no non-BYPASSRLS farmsmart_app role in this DB to prove the live deny)");
      ok(rows[0]!.predicate?.toLowerCase().includes("app.facility_id"), "the SELECT policy must be scoped to the app.facility_id GUC");
      ok(!rows[0]!.predicate?.toLowerCase().includes("current_user"), "the SELECT policy must be role-agnostic (no current_user)");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rowsSeenByA = await db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL ROLE farmsmart_app`);
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgA.organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${orgA.facilityId.toString()}, true)`);
      return tx.select().from(sensorStatusTable).where(eq(sensorStatusTable.facilityId, orgB.facilityId));
    });
    deepStrictEqual(rowsSeenByA, [], "org A's session must never see org B's sensor_status row under RLS");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownRowsSeenByA = await db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL ROLE farmsmart_app`);
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgA.organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${orgA.facilityId.toString()}, true)`);
      return tx.select().from(sensorStatusTable).where(and(eq(sensorStatusTable.facilityId, orgA.facilityId), ne(sensorStatusTable.facilityId, orgB.facilityId)));
    });
    ok(ownRowsSeenByA.length >= 1, "org A's session must still see its OWN sensor_status row under RLS");
  });

  test("GET /dashboard: org B's read is unaffected by org A's cycle/sensor write (no cycles/dashboard regression)", async () => {
    const res = await request(orgB.app).get("/api/dashboard");
    strictEqual(res.status, 200, "GET /dashboard must still succeed after this batch's rescope");
    ok(res.body.sensorStatus, "dashboard response must still include a sensorStatus field");
  });
});
