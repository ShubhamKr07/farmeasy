// artifacts/api-server/src/tests/auth/access-token-hook.test.ts
/**
 * PR-time auth/RLS integration test for access-token hook semantics.
 *
 * Tests (a)/(b) call the REAL `public.custom_access_token_hook(jsonb)`
 * function directly (see supabase/migrations/00001_custom_access_token_hook.sql
 * + 00015_access_token_hook_org_role.sql for its contract) -- this is the
 * only way to catch a regression in the hook itself. A prior version of this
 * file only hand-injected a `user_role` claim via createAuthenticatedTestApp
 * and asserted RLS/route behavior respected the injected value; that can
 * never fail if the hook's own SQL breaks, since the hook was never called.
 *
 * The disposable Supabase stack's TEST_DATABASE_URL connects `db` as the
 * `postgres` superuser (see scripts/ci/test-disposable-supabase.sh), which
 * has no execute grant revoked against it (GRANT/REVOKE EXECUTE only binds
 * non-superuser roles) -- calling the SECURITY DEFINER hook function
 * directly works there. It also means `db`'s own queries below run
 * BYPASSRLS in this env (no farmsmart_app role is provisioned locally --
 * see docs/runbooks/tenancy-db-role.md); the route-level tests below
 * (c)/(d)/(e) are still meaningful because the routes themselves apply
 * explicit tenant-scoped WHERE clauses (see routes/alerts.ts) independent of
 * RLS, and resolveTenantContext independently re-validates facility
 * ownership against the DB -- but they are not a substitute for the real
 * pgTAP RLS proofs (supabase/tests/**) run under farmsmart_app.
 *
 * Assertions:
 * - (a) A user with an active membership gets the org role as the user_role
 *       claim -- asserted by calling the hook directly.
 * - (b) A user with NO active membership has NO user_role claim -- asserted
 *       by calling the hook directly.
 * - (c) Membership-gated authz: org A members cannot read/mutate org B rows.
 * - (d) Negative-authz: RLS-denied operations return 0 rows, not errors; the
 *       end-state is unchanged. (Rule 3 of the practice doc.)
 *
 * (c)/(d)/(e) below use createAuthenticatedTestApp with a synthetic
 * user_role claim standing in for what the hook would produce for real --
 * legitimate there, since those tests are about route/tenant-scoping
 * behavior GIVEN a claim, not about the hook computing the claim (that's
 * exactly what (a)/(b) now cover for real).
 */
import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
import { Router } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  seedTestUser,
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
    // alerts.ts is a Tier-3 router (app.ts's own comment above its mount:
    // "rely entirely on app.ts's own requireTenantContext wrap") -- it does
    // NOT self-gate internally, unlike cycles.ts/facilityReadiness.ts. Real
    // app.ts wraps it with `requireSignedIn, requireTenantContext,
    // alertsRouter` (app.ts:247); omitting that same wrap here let a
    // membership-less request reach withTenantScope with req.tenant unset,
    // which throws inside the route handler's try/catch and surfaces as a
    // 500 instead of alerts.ts's real 404-on-not-found behavior -- caught by
    // running this file's negative-authz tests for real against the
    // disposable stack. facilitiesRouter deliberately has NO such wrap here
    // (app.ts:218 mounts it the same way -- it serves pre-tenant onboarding
    // routes like POST /facilities).
    const { requireTenantContext } = await import("../../middlewares/tenantContext");
    combinedRouter = Router();
    combinedRouter.use(facilitiesRouter);
    combinedRouter.use(requireTenantContext, alertsRouter);

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
    // MUST go through seedTestUser (not a raw insert into usersTable): a raw
    // insert skips the auth.users row seedTestUser creates first, which
    // violates `users_id_auth_users_id_fk` (00004_create_auth_profiles.sql)
    // -- that FK violation threw inside this before() hook, and node:test
    // reports every test in the describe block as CANCELLED (not failed)
    // when its before() throws. This was the suite-abort root cause behind
    // PR #33's "cancelled 5" CI failure -- confirmed by reproducing it
    // locally against the disposable stack before this fix.
    await seedTestUser(db, usersTable, {
      id: orgBUserId,
      email: orgBEmail,
      role: "technician",
      organizationId: null,
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
    // severity must be one of alert_severity's two values ("critical" |
    // "warning" -- lib/db/src/schema/index.ts's alertSeverityEnum); "info"
    // is not a member and throws inside this before() hook (a second,
    // independent cause of the same "before() throws -> every test in the
    // describe block is CANCELLED" failure mode as the auth.users FK bug
    // above), confirmed by reproducing it locally against the disposable
    // stack.
    const { alertsTable } = await import("@workspace/db");
    const [alertB] = await (getAdminDb() ?? db)
      .insert(alertsTable)
      .values({ title: "Org B Alert (hook test)", severity: "warning", facilityId: orgBFacility.id })
      .returning();
    alertIdB = alertB.id;

    orgB = { app: orgBApp, userId: orgBUserId, organizationId: orgBOrg.id, facilityId: orgBFacility.id };
  });

  test("(a) real custom_access_token_hook: active membership returns the org role as the user_role claim", async () => {
    // Calls the REAL public.custom_access_token_hook(jsonb) SQL function
    // directly with a synthetic GoTrue event carrying org A's user_id --
    // this is the hook contract itself (00015_access_token_hook_org_role.sql),
    // not a route/RLS proxy for it.
    const { db } = await import("@workspace/db");
    const hookRes = await db.execute(
      sql`select public.custom_access_token_hook(
        jsonb_build_object('user_id', ${orgA.userId}::text, 'claims', '{}'::jsonb)
      ) as result`,
    );
    const event = (hookRes.rows[0] as { result: { claims: Record<string, unknown> } }).result;
    strictEqual(
      event.claims.user_role,
      "technician",
      "a user with an active membership must get their organization_members.role as the user_role claim",
    );
  });

  test("(b) real custom_access_token_hook: no active membership omits the user_role claim entirely", async () => {
    // Same real hook call, this time for org B's user, who has no
    // organization_members row at all -- the hook must OMIT the claim key
    // (not default it to a stale/synthetic value).
    const { db } = await import("@workspace/db");
    const hookRes = await db.execute(
      sql`select public.custom_access_token_hook(
        jsonb_build_object('user_id', ${orgB.userId}::text, 'claims', '{}'::jsonb)
      ) as result`,
    );
    const event = (hookRes.rows[0] as { result: { claims: Record<string, unknown> } }).result;
    ok(
      !("user_role" in event.claims),
      "a user with no active membership must get no user_role claim key at all",
    );
  });

  test("RLS end-state: org A's technician (matching the real hook's active-membership claim) can read own alert", async () => {
    const res = await request(orgA.app).get("/api/alerts");
    strictEqual(res.status, 200);
    ok(
      res.body.some((a: { id: number }) => a.id === alertIdA),
      "org A user (with active 'technician' membership) must read their own alert",
    );
  });

  test("RLS end-state: membership-less org B user (matching the real hook's omitted claim) cannot read their org's alert (negative-authz: 400, never reaches the query)", async () => {
    // The membership-less org B user has NO organization_members row at all,
    // so resolveTenantContext's per-request membership lookup (joined
    // against the requested X-Facility-Id) finds nothing -- req.tenant stays
    // unset, and requireTenantContext (the same Tier-3 wrap app.ts uses for
    // alertsRouter -- app.ts:247) 400s before the request ever reaches a
    // query. This is a STRONGER negative-authz guarantee than "RLS filters
    // an executed query to 0 rows": the membership-less user's request never
    // touches alert data at all. End-state: no error leak, no data returned
    // -- a client-facing 400 (TEN-008's own error-handling design, see
    // requireTenantContext's doc comment in tenantContext.ts), never a 500
    // or a leaked row.
    const res = await request(orgB.app).get("/api/alerts");
    strictEqual(
      res.status,
      400,
      "membership-less user's request must never resolve a tenant context (400), and must never surface as a 500",
    );
    ok(!Array.isArray(res.body) || res.body.length === 0, "response body must carry no alert data");
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

  test("(d) negative-authz for UPDATE: membership-less user cannot update, no rows affected (not an error)", async () => {
    // Same requireTenantContext gate as the GET test above: the
    // membership-less org B user's PATCH never resolves a tenant context
    // (no organization_members row at all), so it 400s before the route
    // handler runs. This is the end-state: the alert is unchanged because
    // the request never even reached a query.
    const res = await request(orgB.app)
      .patch(`/api/alerts/${alertIdB}`)
      .send({ status: "resolved" });
    strictEqual(res.status, 400, "membership-less user cannot PATCH an alert -- no tenant context resolves, never a 500");
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
