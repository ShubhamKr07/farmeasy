import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * GET/PUT /wizard/progress (onboarding wizard Task 4, WIZ-001 resume
 * support). One row per user (unique index on `wizard_progress.user_id`):
 * GET returns null until the user has saved any progress; PUT upserts
 * `currentStep` + `stepData`, merging (not clobbering) `stepData` when a
 * caller only sends `currentStep` to advance the step.
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
    const wizard = await import("../../routes/wizard");
    const { db, usersTable, wizardProgressTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    return { app: createAuthenticatedTestApp(wizard.default), db, wizardProgressTable };
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
});
