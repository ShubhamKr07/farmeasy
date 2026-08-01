import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

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

describe("GET/PUT /api/wizard/progress", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["wizard_progress", "users"]);

  async function setup() {
    const wizard = await import("../../routes/wizard");
    const { db, usersTable, wizardProgressTable } = await import("@workspace/db");
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
    });
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

  // Regression test for the lost-update race a code review caught: a plain
  // read-then-write (SELECT stepData, then a separate INSERT/UPDATE) lets a
  // concurrent draft-save and advance-only PUT interleave, so whichever
  // commits second can silently overwrite the other's already-saved
  // stepData with stale/empty data. The fix wraps the read + upsert in one
  // transaction with `SELECT ... FOR UPDATE` (same precedent as
  // facilities.ts) so concurrent PUTs for the same user serialize instead of
  // racing. Fired via Promise.all against the real test database so the two
  // requests' transactions genuinely overlap, not just call the handler
  // twice sequentially.
  test("concurrent draft-save + advance-only PUTs never lose the draft to a race", async () => {
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
});
