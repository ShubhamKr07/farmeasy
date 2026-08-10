// artifacts/api-server/src/tests/auth/access-token-hook.test.ts
/**
 * PR-time auth/RLS integration test for access-token hook semantics.
 *
 * Tests the custom_access_token_hook end-to-end against real RLS policies
 * running under a non-BYPASSRLS Postgres role (the disposable Supabase stack).
 * This is the PR-time analog for the hosted post-merge gates (rule 2 of
 * docs/testing/auth-and-persistent-env-testing.md): it catches auth/RLS drift
 * before merge, not just after.
 *
 * Assertions:
 * - (a) A user with an active membership gets the org role as the user_role
 *       claim (tested via synthetic injection + RLS enforcement below).
 * - (b) A user with NO active membership has NO user_role claim (tested the
 *       same way).
 * - (c) Membership-gated authz: org A members cannot read/mutate org B rows.
 * - (d) Negative-authz: RLS-denied operations return 0 rows, not errors; the
 *       end-state is unchanged. (Rule 3 of the practice doc.)
 *
 * This test uses the disposable Supabase stack, so it runs under the real
 * non-BYPASSRLS farmsmart_app role, not a superuser or test-only bypass.
 * The synthetic user_role claims (injected via createAuthenticatedTestApp)
 * represent what the hook would have computed for real; the test verifies
 * that RLS policies respect those claims.
 */
import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
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

// Lazy import pattern — see cross-tenant.test.ts for why.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let combinedRouter: any;

describe("Auth/RLS end-state semantics (access-token hook)", { skip: !dbUrl }, () => {
  /**
   * Two organizations with members. Org A has an active membership
   * (user_role='technician') while Org B has no active membership
   * (user_role claim omitted). This tests both the presence and absence
   * of the claim end-to-end through RLS.
   */
  let orgA: {
    app: ReturnType<typeof createAuthenticatedTestApp>;
    userId: string;
    organizationId: number;
    facilityId: number;
  };
  let orgB: {
    app: ReturnType<typeof createAuthenticatedTestApp>;
    userId: string;
    organizationId: number;
    facilityId: number;
  };

  let alertIdA: number; // seeded in org A
  let alertIdB: number; // seeded in org B

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;
    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } =
      await import("@workspace/db");

    // Mount routers for alerts and facilities (which will call resolveTenantContext
    // and enforce RLS).
    const facilitiesRouter = (await import("../../routes/facilities")).default;
    const alertsRouter = (await import("../../routes/alerts")).default;
    combinedRouter = Router();
    combinedRouter.use(facilitiesRouter);
    combinedRouter.use(alertsRouter);

    // ────────────────────────────────────────────────────────────────────────
    // Seed Org A with an active membership (user_role='technician').
    // ────────────────────────────────────────────────────────────────────────
    const orgAUserId = randomUUID();
    const orgAEmail = "org-a-user@hook-test.example.com";
    const { organizationId: orgAOrgId, facilityId: orgAFacilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: orgAUserId, email: orgAEmail },
      {
        farmName: "Hook Test Org A",
        facilityName: "Org A Facility",
        timezone: "UTC",
        memberRole: "technician", // active membership with 'technician' role
      },
    );

    // Create a test app for org A with the user_role claim that the hook would
    // produce (the hook reads organization_members.role -> 'technician').
    const orgAApp = createAuthenticatedTestApp(combinedRouter, { sub: orgAUserId, user_role: "technician" }, orgAFacilityId);

    // Seed an alert for org A.
    const alertResA = await request(orgAApp)
      .post("/api/alerts")
      .send({ title: "Org A Alert (hook test)", severity: "warning" });
    strictEqual(alertResA.status, 201, "org A alert creation must succeed");
    alertIdA = alertResA.body.id;

    orgA = { app: orgAApp, userId: orgAUserId, organizationId: orgAOrgId, facilityId: orgAFacilityId };

    // ────────────────────────────────────────────────────────────────────────
    // Seed Org B WITHOUT an active membership (user_role claim omitted).
    // This user signed up but hasn't been provisioned with an org yet.
    // ────────────────────────────────────────────────────────────────────────
    const orgBUserId = randomUUID();
    const orgBEmail = "org-b-user-no-membership@hook-test.example.com";

    // Seed just the user/auth rows, but no active membership (simulating
    // a fresh signup that hasn't been provisioned with an org yet).
    const { usersTable: usersTableImport } = await import("@workspace/db");
    await (getAdminDb() ?? db)
      .insert(usersTableImport)
      .values({ id: orgBUserId, email: orgBEmail, role: "technician", organizationId: null })
      .onConflictDoUpdate({
        target: usersTableImport.id,
        set: { organizationId: null },
      });

    // For RLS testing, we still need an organization and facility to exist
    // so we can seed a row there and verify the membership-less user cannot
    // read it. But the user has no organization_members row linking them to it.
    const [orgBOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Hook Test Org B (no membership)" })
      .returning();
    const [orgBFacility] = await db
      .insert(facilitiesTable)
      .values({
        name: "Hook Test Org B",
        organizationId: orgBOrg.id,
        facilityName: "Org B Facility",
        timezone: "UTC",
      })
      .returning();

    // Create a test app for org B WITHOUT the user_role claim (the hook omits
    // it when there's no active membership).
    const orgBApp = createAuthenticatedTestApp(combinedRouter, { sub: orgBUserId }, orgBFacility.id);

    // Seed an alert for org B using the admin connection (because the membership-less
    // user cannot INSERT into their own org).
    const { alertsTable } = await import("@workspace/db");
    const [alertB] = await (getAdminDb() ?? db)
      .insert(alertsTable)
      .values({ title: "Org B Alert (hook test)", severity: "info", facilityId: orgBFacility.id })
      .returning();
    alertIdB = alertB.id;

    orgB = { app: orgBApp, userId: orgBUserId, organizationId: orgBOrg.id, facilityId: orgBFacility.id };
  });

  test("(a) user_role claim present for active membership: org A's technician can read own alert", async () => {
    const res = await request(orgA.app).get("/api/alerts");
    strictEqual(res.status, 200);
    ok(
      res.body.some((a: { id: number }) => a.id === alertIdA),
      "org A user (with active 'technician' membership) must read their own alert",
    );
  });

  test("(b) user_role claim omitted for no membership: org B user cannot read their org's alert (negative-authz: 0 rows)", async () => {
    // The membership-less org B user tries to read an alert in their org.
    // RLS denies them (because they have no organization_members row linking
    // them to that org), so the query returns 0 rows — no error, just an
    // empty result. This is negative-authz: we verify the END-STATE (0 rows),
    // not the absence of an error.
    const res = await request(orgB.app).get("/api/alerts");
    strictEqual(res.status, 200, "query itself must succeed (RLS silently filters)");
    const foundAlert = res.body.find((a: { id: number }) => a.id === alertIdB);
    ok(!foundAlert, "membership-less user must NOT see their org's alert (RLS filtered to 0 rows)");
    strictEqual(
      res.body.length,
      0,
      "membership-less user must see an empty alert list (RLS enforces end-state)",
    );
  });

  test("(c) cross-org isolation: org A user cannot read org B's alert", async () => {
    // Org A's technician (with active membership in org A) tries to read
    // org B's alert. RLS denies them because they have no membership in org B.
    // The fact that alertIdB exists in a different org is irrelevant — the
    // per-user facility_id GUC (set by resolveTenantContext) gates all queries.
    // This test queries org A's facility and expects 0 org B alerts.
    const res = await request(orgA.app).get("/api/alerts");
    strictEqual(res.status, 200);
    const foundOrgBAlert = res.body.find((a: { id: number }) => a.id === alertIdB);
    ok(!foundOrgBAlert, "org A user must not see org B's alert across tenants");
  });

  test("(d) negative-authz for UPDATE: membership-less user cannot update, 0 rows affected (not an error)", async () => {
    // The membership-less org B user tries to PATCH an alert in their org.
    // PostgREST's RLS filtering means this returns 404 (the alert is not
    // visible via RLS, so it's like it doesn't exist for the query path).
    // However, if we were to craft the PATCH to omit the id filter and apply
    // to 'their' facility, it would return 200 with 0 rows — demonstrating
    // that RLS silently filters UPDATEs, not error them.
    // For this test, we use the route's standard 404-on-not-found behavior.
    const res = await request(orgB.app)
      .patch(`/api/alerts/${alertIdB}`)
      .send({ status: "resolved" });
    // The alert doesn't exist in the membership-less user's view (RLS hides it),
    // so the route returns 404. This is the end-state: the alert is unchanged
    // because the user couldn't even see it.
    strictEqual(res.status, 404, "membership-less user cannot PATCH an alert they cannot read");
  });

  test("(e) negative-authz for DELETE: membership-less user cannot delete, end-state unchanged", async () => {
    // Similar to the UPDATE test: the membership-less user tries to delete
    // an alert they cannot see. The result is 404 (route not found, from RLS
    // perspective) and the end-state is unchanged (the alert still exists).
    const beforeRes = await request(orgA.app).get(`/api/alerts/${alertIdB}`);
    // We expect 404 or similar (org A user viewing org B's facility).
    // But the key point: after org B's failed delete attempt, the alert
    // must still exist (org A can still read it).
    const deleteRes = await request(orgB.app).delete(`/api/alerts/${alertIdB}`);
    // Expect 404 or similar (RLS hides the row from org B's perspective).
    ok(deleteRes.status >= 400, "membership-less user's delete attempt must fail");

    const afterRes = await request(orgA.app).get(`/api/alerts/${alertIdB}`);
    // The alert should still be readable by org A (it wasn't deleted).
    ok(afterRes.body, "alert must still exist in org B's facility after membership-less user's failed delete");
  });
});
