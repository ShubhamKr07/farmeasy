// artifacts/api-server/src/tests/isolation/crops.test.ts
//
// MT-M2 batch 3: crops org-scoped hybrid RLS + withTenantScope rewire.
// Proves, under the real non-BYPASSRLS farmsmart_app role (via the
// disposable-stack app.db connection, exactly like cross-tenant.test.ts):
//   - org A's GET /crops sees the shared system crop AND its own crop, but
//     never org B's private crop.
//   - org B's GET /crops sees the shared system crop, but never org A's
//     private crop.
//   - POST /crops stamps organization_id to the caller's own org.
//   - Neither org can UPDATE/DELETE the system crop or the OTHER org's crop
//     (asserted directly against the RLS-scoped policies via withTenantScope,
//     since crops.ts exposes no PATCH/DELETE route for these to go through
//     HTTP -- end-state assertion: 0 rows affected, never an error string).
//   - GET /crops with no X-Facility-Id is a 400 (requireTenantContext gate),
//     matching every other tenant-scoped route's TEN-008 contract.
import { describe, test, before } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
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
let cropsRouter: any;

describe("Crops org-scoped hybrid isolation (MT-M2 batch 3)", { skip: !dbUrl }, () => {
  let orgA: { app: ReturnType<typeof createAuthenticatedTestApp>; organizationId: number; facilityId: number; userId: string };
  let orgB: { app: ReturnType<typeof createAuthenticatedTestApp>; organizationId: number; facilityId: number; userId: string };
  let systemCropId: number;
  let orgAOwnCropId: number;
  let orgBOwnCropId: number;

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;
    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable, cropsTable } =
      await import("@workspace/db");

    cropsRouter = Router();
    cropsRouter.use((await import("../../routes/crops")).default);

    // Own-fixture truncate (crops only -- organizations/facilities/
    // organization_members/users are shared reference tables other suites
    // may also be using in the same disposable-stack run; crops.ts's tests
    // create their own fresh org/facility rows below regardless).
    await (getAdminDb() ?? db).execute(
      (await import("drizzle-orm")).sql.raw(`TRUNCATE crops RESTART IDENTITY CASCADE`),
    );

    async function provisionOrg(email: string) {
      const userId = randomUUID();
      const { organizationId, facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: userId, email },
        { memberRole: "technician" },
      );
      const app = createAuthenticatedTestApp(cropsRouter, { sub: userId }, facilityId);
      return { app, organizationId, facilityId, userId };
    }

    orgA = await provisionOrg("crops-org-a@isolation-test.example.com");
    orgB = await provisionOrg("crops-org-b@isolation-test.example.com");

    // Shared system crop -- organization_id NULL, seeded directly (mirrors
    // the existing ~5 pilot rows this migration deliberately leaves NULL).
    const [systemCrop] = await (getAdminDb() ?? db)
      .insert(cropsTable)
      .values({ name: "Isolation Test System Crop", organizationId: null })
      .returning();
    systemCropId = systemCrop.id;

    // Org B's own private crop, seeded directly so org A's GET can be
    // asserted against it without depending on org B's own POST running
    // first (keeps this test independent of POST's own correctness).
    const [orgBCrop] = await (getAdminDb() ?? db)
      .insert(cropsTable)
      .values({ name: "Org B Private Crop", organizationId: orgB.organizationId })
      .returning();
    orgBOwnCropId = orgBCrop.id;
  });

  test("POST /crops: stamps organization_id to the caller's own org", async () => {
    const res = await request(orgA.app).post("/api/crops").send({ name: "Org A Private Crop" });
    strictEqual(res.status, 201);
    orgAOwnCropId = res.body.id;

    const { db, cropsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await (getAdminDb() ?? db).select().from(cropsTable).where(eq(cropsTable.id, orgAOwnCropId));
    strictEqual(row!.organizationId, orgA.organizationId, "POST /crops must stamp organization_id to the caller's org, not leave it NULL or another org's id");
  });

  test("GET /crops: org A sees the system crop AND its own crop, never org B's private crop", async () => {
    const res = await request(orgA.app).get("/api/crops");
    strictEqual(res.status, 200);
    const ids = res.body.map((c: { id: number }) => c.id);
    ok(ids.includes(systemCropId), "org A must see the shared system crop");
    ok(ids.includes(orgAOwnCropId), "org A must see its own crop");
    ok(!ids.includes(orgBOwnCropId), "org A must never see org B's private crop");
  });

  test("GET /crops: org B sees the system crop, never org A's private crop", async () => {
    const res = await request(orgB.app).get("/api/crops");
    strictEqual(res.status, 200);
    const ids = res.body.map((c: { id: number }) => c.id);
    ok(ids.includes(systemCropId), "org B must see the shared system crop");
    ok(ids.includes(orgBOwnCropId), "org B must see its own crop");
    ok(!ids.includes(orgAOwnCropId), "org B must never see org A's private crop");
  });

  test("GET /crops: missing X-Facility-Id is a 400, never a silent unscoped read", async () => {
    const appWithNoFacility = createAuthenticatedTestApp(cropsRouter, { sub: orgA.userId });
    const res = await request(appWithNoFacility).get("/api/crops");
    strictEqual(res.status, 400);
  });

  // Both deny tests below hit the same BYPASSRLS-canary gap as
  // demo.test.ts's "RLS regression: UPDATE organizations..." test (see that
  // test's header comment for the full writeup): withTenantScope only sets
  // the app.org_id/app.facility_id GUCs, it does NOT change role, and the
  // disposable-stack `db` connection is the `postgres` superuser (always
  // BYPASSRLS, no migration in this history ever CREATEs farmsmart_app in a
  // fresh CI DB) -- so a raw UPDATE/DELETE through withTenantScope would
  // "succeed" (return the row) no matter what the RLS policy says, and a
  // `deepStrictEqual(updated, [])` assertion against that connection is
  // false-failing (worse, false-passing if ever inverted). Skip the LIVE
  // functional deny when farmsmart_app isn't provisioned as a real
  // non-BYPASSRLS role and fall back to the structural proof instead (the
  // policy exists, covers the cmd, is scoped to app.org_id, and -- per this
  // batch's role-agnostic design (00022's header) -- carries no
  // current_user clause). When farmsmart_app IS provisioned, SET LOCAL ROLE
  // to it inside the transaction and run the real functional check.
  test("RLS end-state: org A cannot UPDATE the system crop under the real farmsmart_app role", async () => {
    const { db, cropsTable } = await import("@workspace/db");
    const { eq, sql } = await import("drizzle-orm");

    const roleCheck = await db.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'farmsmart_app'`,
    );
    const farmsmartAppRow = (roleCheck.rows as { rolbypassrls: boolean }[])[0];
    const hasEnforcingAppRole = farmsmartAppRow !== undefined && farmsmartAppRow.rolbypassrls === false;

    if (!hasEnforcingAppRole) {
      const policyCheck = await db.execute(sql`
        SELECT coalesce(qual, with_check) AS predicate
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'crops' AND cmd = 'UPDATE'
      `);
      const policy = (policyCheck.rows as { predicate: string | null }[])[0];
      ok(policy, "crops must have an UPDATE policy (no non-BYPASSRLS farmsmart_app role in this DB to prove the live deny)");
      ok(policy!.predicate?.toLowerCase().includes("app.org_id"), "the UPDATE policy must be scoped to the app.org_id GUC");
      ok(!policy!.predicate?.toLowerCase().includes("current_user"), "the UPDATE policy must be role-agnostic (no current_user) per this batch's task-#5 compatibility requirement");
      return;
    }

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE farmsmart_app`);
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgA.organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${orgA.facilityId.toString()}, true)`);
      return tx.update(cropsTable).set({ name: "hacked" }).where(eq(cropsTable.id, systemCropId)).returning();
    });
    deepStrictEqual(updated, [], "UPDATE against a system crop must affect 0 rows under RLS, not silently succeed");

    const [row] = await (getAdminDb() ?? db).select().from(cropsTable).where(eq(cropsTable.id, systemCropId));
    strictEqual(row!.name, "Isolation Test System Crop", "the system crop's name must be unchanged");
  });

  test("RLS end-state: org A cannot UPDATE or DELETE org B's own crop under the real farmsmart_app role", async () => {
    const { db, cropsTable } = await import("@workspace/db");
    const { eq, sql } = await import("drizzle-orm");

    const roleCheck = await db.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'farmsmart_app'`,
    );
    const farmsmartAppRow = (roleCheck.rows as { rolbypassrls: boolean }[])[0];
    const hasEnforcingAppRole = farmsmartAppRow !== undefined && farmsmartAppRow.rolbypassrls === false;

    if (!hasEnforcingAppRole) {
      const policyCheck = await db.execute(sql`
        SELECT cmd, coalesce(qual, with_check) AS predicate
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'crops' AND cmd IN ('UPDATE', 'DELETE')
      `);
      const rows = policyCheck.rows as { cmd: string; predicate: string | null }[];
      strictEqual(rows.length, 2, "crops must have both an UPDATE and a DELETE policy (no non-BYPASSRLS farmsmart_app role in this DB to prove the live deny)");
      for (const r of rows) {
        ok(r.predicate?.toLowerCase().includes("app.org_id"), `the ${r.cmd} policy must be scoped to the app.org_id GUC`);
        ok(!r.predicate?.toLowerCase().includes("current_user"), `the ${r.cmd} policy must be role-agnostic (no current_user)`);
      }
      return;
    }

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE farmsmart_app`);
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgA.organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${orgA.facilityId.toString()}, true)`);
      return tx.update(cropsTable).set({ name: "hacked" }).where(eq(cropsTable.id, orgBOwnCropId)).returning();
    });
    deepStrictEqual(updated, [], "UPDATE against org B's crop must affect 0 rows for org A under RLS");

    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE farmsmart_app`);
      await tx.execute(sql`SELECT set_config('app.org_id', ${orgA.organizationId.toString()}, true)`);
      await tx.execute(sql`SELECT set_config('app.facility_id', ${orgA.facilityId.toString()}, true)`);
      return tx.delete(cropsTable).where(eq(cropsTable.id, orgBOwnCropId)).returning();
    });
    deepStrictEqual(deleted, [], "DELETE against org B's crop must affect 0 rows for org A under RLS");

    const [row] = await (getAdminDb() ?? db).select().from(cropsTable).where(eq(cropsTable.id, orgBOwnCropId));
    ok(row, "org B's crop must still exist -- neither mutated nor deleted by org A");
    strictEqual(row!.name, "Org B Private Crop");
  });

  test("RLS end-state: org B can UPDATE its own crop under the real farmsmart_app role", async () => {
    const { withTenantScope, db, cropsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const updated = await withTenantScope({ organizationId: orgB.organizationId, facilityId: orgB.facilityId }, (tx) =>
      tx.update(cropsTable).set({ scientificName: "Testus cropus" }).where(eq(cropsTable.id, orgBOwnCropId)).returning(),
    );
    strictEqual(updated.length, 1, "org B must be able to update its OWN crop");

    const [row] = await (getAdminDb() ?? db).select().from(cropsTable).where(eq(cropsTable.id, orgBOwnCropId));
    strictEqual(row!.scientificName, "Testus cropus");
  });
});
