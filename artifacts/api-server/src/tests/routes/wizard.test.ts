import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

/**
 * GET/PUT /wizard/progress (onboarding wizard Task 4, WIZ-001 resume
 * support; multi-facility support TEN-008 Task 7). Post-TEN-008, rows are
 * keyed per (user_id, facility_id) — a composite unique index for real
 * facilities, plus a partial unique index (`facility_id IS NULL`) for the
 * one in-progress, not-yet-facility-created run a user can have at a time.
 * GET without `?facilityId` resolves that null-facility row; GET with it
 * resolves a specific facility's own row (re-entering "Add facility"). PUT
 * upserts `currentStep` + `stepData`, merging (not clobbering) `stepData`
 * when a caller only sends `currentStep` to advance the step, and — on the
 * first PUT to supply `facilityId` — transitions the null-facility row into
 * that facility's row in place (never a second insert).
 *
 * Gated on TEST_DATABASE_URL, same lazy-import pattern as facilities.test.ts.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("GET/PUT /api/wizard/progress", { skip: !dbUrl }, () => {
  // Only `wizard_progress` is truncated. `users` is a shared reference table
  // a dozen other tables now foreign-key into (facility_logs, sensor_accounts,
  // recommender_queries, ...); truncating it here would cascade into all of
  // them. Every query in this file is scoped to `DEFAULT_TEST_USER.sub` and
  // `seedTestUser`'s upsert already resets that one user's row per call —
  // never relies on the whole `users` table being empty.
  const fixture = useDatabaseFixture(["wizard_progress"]);

  async function setup() {
    const wizardModule = await import("../../routes/wizard");
    // TEN-008's PUT-facilityId tests below need to actually create a
    // facility mid-test (via POST /facilities) on the SAME app instance, so
    // the test app mounts both routers together — mirroring app.ts, which
    // mounts both under `/api` too — rather than just the wizard router
    // alone as before facilityId threading existed.
    const facilitiesModule = await import("../../routes/facilities");
    const { db, usersTable, organizationsTable, organizationMembersTable, wizardProgressTable } = await import("@workspace/db");
    const { Router } = await import("express");
    const adb = getAdminDb() ?? db;
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    // TEN-012: POST /facilities no longer creates the org — the wizard
    // bootstrap (ensureOwnerOrg, from GET /wizard/progress) does. Seed one
    // active owner membership up front (delete-first, since
    // organization_members is shared and never truncated here) so the
    // POST /facilities calls in the tests below have an org to attach to;
    // GET /wizard/progress's own ensureOwnerOrg call is then a no-op for this
    // already-provisioned user.
    await adb.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
    const [org] = await adb.insert(organizationsTable).values({ name: "Wizard Test Org" }).returning();
    await adb.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId: DEFAULT_TEST_USER.sub,
      role: "owner",
      status: "active",
    });
    const combinedRouter = Router();
    combinedRouter.use(facilitiesModule.default);
    combinedRouter.use(wizardModule.default);
    return { app: createAuthenticatedTestApp(combinedRouter), db, wizardProgressTable };
  }

  test("GET returns null when the user hasn't started the wizard yet", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/wizard/progress");
    strictEqual(res.status, 200);
    strictEqual(res.body, null);
  });

  test("PUT creates progress, GET then returns it", async () => {
    const { app } = await setup();
    const putRes = await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "layout", stepData: { farmName: "Sunrise Greens" } });

    strictEqual(putRes.status, 200);
    strictEqual(putRes.body.currentStep, "layout");
    ok(putRes.body.stepData);
    strictEqual(putRes.body.stepData.farmName, "Sunrise Greens");

    const getRes = await request(app).get("/api/wizard/progress");
    strictEqual(getRes.status, 200);
    strictEqual(getRes.body.currentStep, "layout");
    strictEqual(getRes.body.stepData.farmName, "Sunrise Greens");
  });

  test("PUT without stepData advances currentStep but preserves the prior draft", async () => {
    const { app } = await setup();
    await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "layout", stepData: { farmName: "Sunrise Greens" } });

    const advanceRes = await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "sensors_accounts" });

    strictEqual(advanceRes.status, 200);
    strictEqual(advanceRes.body.currentStep, "sensors_accounts");
    strictEqual(advanceRes.body.stepData.farmName, "Sunrise Greens");
  });

  test("PUT upserts on the same user (one row, not one per call)", async () => {
    const { app, db, wizardProgressTable } = await setup();

    await request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" });
    await request(app).put("/api/wizard/progress").send({ currentStep: "layout" });

    const rows = await db
      .select()
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    strictEqual(rows.length, 1);
    strictEqual(rows[0].currentStep, "layout");
  });

  // Regression test for the lost-update race a code review caught, for the
  // case where a wizard_progress row already exists: a concurrent draft-save
  // and advance-only PUT must never let the advance-only call's write
  // silently overwrite the draft-save's already-saved stepData. Fired via
  // Promise.all against the real test database so the two requests
  // genuinely overlap, not just call the handler twice sequentially. Seeds
  // an existing row first (sequential PUT) specifically so this test's
  // concurrent pair races against an UPDATE path — the separate test below
  // covers the narrower, no-existing-row race this one can't reach.
  test("concurrent draft-save + advance-only PUTs never lose the draft to a race (existing row)", async () => {
    const { app, db, wizardProgressTable } = await setup();

    await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "layout", stepData: { farmName: "Sunrise Greens" } });

    await Promise.all([
      request(app)
        .put("/api/wizard/progress")
        .send({ currentStep: "layout", stepData: { farmName: "Sunrise Greens", timezone: "UTC" } }),
      request(app).put("/api/wizard/progress").send({ currentStep: "sensors_accounts" }),
    ]);

    const [row] = await db
      .select()
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    const stepData = row.stepData as Record<string, unknown>;
    ok(stepData.farmName, "draft's farmName must survive a concurrent advance-only PUT");
  });

  // Regression test for the narrower race a second review round caught: a
  // transaction + `SELECT ... FOR UPDATE` only closes the race once a row
  // exists to lock. For a user's very first-ever save, there is no row yet,
  // so both concurrent PUTs' SELECTs see nothing to lock, both compute
  // stepData from only their own request body in JS, and only then does
  // Postgres's ON CONFLICT serialize the actual INSERTs — by which point
  // each statement's SET values were already fixed. Whichever insert loses
  // that row-level race and converts to the conflict-UPDATE could still
  // clobber the winner's just-committed draft with its own stale
  // precomputed value.
  //
  // Deliberately does NOT seed a row first (unlike the test above) — these
  // two PUTs are the very first requests for this user, fired concurrently,
  // so this test exercises the INSERT-vs-INSERT-that-becomes-UPDATE path the
  // seeded test above cannot reach. The fix (a single atomic upsert whose
  // SET clause references the target table's own stepData column instead of
  // a JS-computed value when no stepData was sent) has no separate read at
  // any point, for any row state, so this race is closed regardless of
  // which request's INSERT Postgres resolves first.
  test("concurrent draft-save + advance-only PUTs never lose the draft on a user's very first save", async () => {
    const { app, db, wizardProgressTable } = await setup();

    await Promise.all([
      request(app)
        .put("/api/wizard/progress")
        .send({ currentStep: "layout", stepData: { farmName: "Sunrise Greens" } }),
      request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" }),
    ]);

    const rows = await db
      .select()
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    strictEqual(rows.length, 1, "the unique userId index must still collapse both concurrent inserts to one row");
    const stepData = rows[0].stepData as Record<string, unknown>;
    ok(stepData.farmName, "draft's farmName must survive regardless of which concurrent insert wins the conflict");
  });

  // TEN-008 Task 7: the first PUT to supply facilityId must transition the
  // existing null-facility row in place, not insert a second row. This is
  // the exact behavior the onConflictDoUpdate `targetWhere` fix (see
  // wizard.ts's comment above the upsert) exists to guarantee for the
  // ordinary (non-concurrent) case; the UPDATE-first branch in the PUT
  // handler is what actually transitions this specific row, since it's an
  // UPDATE keyed on (userId, facility_id IS NULL), not an upsert at all.
  test("PUT /wizard/progress: stamping facilityId on first supply transitions the null-facility row, not a new insert", async () => {
    const { app, db, wizardProgressTable } = await setup();
    await request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" });

    const facilityRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Stamp Test Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(facilityRes.status, 201);
    const facilityId = facilityRes.body.facilityId as number;

    const putRes = await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "layout", facilityId });
    strictEqual(putRes.status, 200);
    strictEqual(putRes.body.facilityId, facilityId);
    strictEqual(putRes.body.currentStep, "layout");

    const rows = await db.select().from(wizardProgressTable).where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    strictEqual(rows.length, 1, "the null-facility row must be transitioned in place, never a second row inserted");
  });

  test("GET /wizard/progress: with facilityId resumes that facility's own row, distinct from the in-progress (facility_id IS NULL) run", async () => {
    const { app } = await setup();
    await request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" });
    const facilityRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Resume Test Farm", timezone: "UTC", units: "metric", currency: "USD" });
    const facilityId = facilityRes.body.facilityId as number;
    await request(app).put("/api/wizard/progress").send({ currentStep: "done", facilityId });

    // A brand-new "Add facility" run starts a second, unassigned row.
    const newRunRes = await request(app).get("/api/wizard/progress");
    strictEqual(newRunRes.status, 200);
    strictEqual(newRunRes.body, null, "no in-progress unassigned run exists yet after the first one was stamped");

    const resumeRes = await request(app).get("/api/wizard/progress").query({ facilityId });
    strictEqual(resumeRes.status, 200);
    strictEqual(resumeRes.body.currentStep, "done");
  });

  test("GET /wizard/progress: facilityId belonging to a different organization is a 400, not a leak", async () => {
    const { app } = await setup();
    const otherOrgUserId = randomUUID();
    const { seedTenantContext } = await import("../helpers/testDatabase");
    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import("@workspace/db");
    // seedTenantContext returns the facilityId it just created for this
    // brand-new synthetic user/org — used directly rather than a bare
    // `.limit(1)` off the shared, never-truncated `facilities` table (which
    // also holds every facility this file's other tests, and other test
    // files, have created — an unordered `.limit(1)` could return an
    // arbitrary one of those instead of a genuinely different org's
    // facility, the exact property this test claims to verify).
    const seeded = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      // Email keyed off otherOrgUserId (not a fixed literal): auth.users has
      // a unique index on email, and this table is never truncated between
      // runs — a fixed literal here would collide on a re-run the same way
      // cross-tenant.test.ts's known residue issue does. randomUUID() already
      // makes otherOrgUserId unique per run, so folding it into the email
      // keeps this test re-runnable without manual cleanup.
      { id: otherOrgUserId, email: `other-org-${otherOrgUserId}@wizard-test.example.com` },
    );

    const res = await request(app).get("/api/wizard/progress").query({ facilityId: seeded.facilityId });
    strictEqual(res.status, 400);
  });
});
