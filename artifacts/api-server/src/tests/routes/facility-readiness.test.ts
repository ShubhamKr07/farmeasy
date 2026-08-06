import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  seedTenantContext,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * GET /facility-readiness + POST /facility-readiness/events (onboarding
 * wizard Task 12, CHK-001..003).
 *
 * The single most important invariant in this whole feature: `completedCount`
 * must always equal the number of `items` whose `state === "done"`. The
 * handler guarantees this by construction — `completedCount` is derived by
 * filtering the exact `items` array returned in the same response, never
 * computed as a second, independent tally — so the two numbers cannot
 * diverge. The first test below asserts this holds for whatever state the
 * checklist happens to be in.
 *
 * Gated on TEST_DATABASE_URL, mirroring facilities.test.ts/sensor-accounts.test.ts:
 * the router and `@workspace/db` are imported lazily inside `setup()` so this
 * file loads (and skips cleanly) even when no test database is configured.
 *
 * TEN-008: the route is now scoped to `req.tenant.facilityId`, resolved by
 * `requireTenantContext`/`resolveTenantContext` from an `organization_members`
 * row + the client-sent `X-Facility-Id` header — not "the org's one facility"
 * anymore. `setup()` uses `seedTenantContext` (same helper/pattern as
 * tasks.test.ts/shipments.test.ts) to seed an organization, a facility, and an
 * active `organization_members` row linking `DEFAULT_TEST_USER.sub` to that
 * org, then passes the resulting `facilityId` as `createAuthenticatedTestApp`'s
 * third argument so the test double attaches it as `X-Facility-Id`. Tests for
 * "no facility yet" seed a user with no membership at all and omit the
 * `facilityId` argument, so no `X-Facility-Id` header is sent and
 * `requireTenantContext` 400s before the handler ever runs.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

describe("GET /api/facility-readiness", { skip: !dbUrl }, () => {
  // Only `facility_readiness_events` is truncated. `facilities`/`organizations`/
  // `users`/`organization_members` are shared reference tables the FK graph now
  // fans out through (TRUNCATE ... CASCADE would destroy every cycles/
  // inventory_items/alerts/tasks/shipments/... row plus the pilot-default
  // facility other suites resolve via `ORDER BY id LIMIT 1`). Every setup()
  // here creates its own fresh org+facility+membership and every assertion is
  // keyed off that returned facilityId — never off these tables being globally
  // empty.
  const fixture = useDatabaseFixture(["facility_readiness_events"]);

  async function setup() {
    const facilityReadiness = await import("../../routes/facility-readiness");
    const { db, organizationsTable, facilitiesTable, usersTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    const { organizationId, facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
      { farmName: "Sunrise Greens", facilityName: "Sunrise Greens" },
    );
    return {
      app: createAuthenticatedTestApp(facilityReadiness.default, DEFAULT_TEST_USER, facilityId),
      db,
      organizationId,
      facilityId,
    };
  }

  test("completedCount always equals the number of done items", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/facility-readiness");
    strictEqual(res.status, 200);
    const doneCount = res.body.items.filter((i: { state: string }) => i.state === "done").length;
    strictEqual(res.body.completedCount, doneCount);
  });

  test("item 1 (labels) is never done from a page visit — only from a labels_scanned event", async () => {
    const { app } = await setup();

    const res1 = await request(app).get("/api/facility-readiness");
    strictEqual(res1.status, 200);
    strictEqual(res1.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "pending");

    const postRes1 = await request(app)
      .post("/api/facility-readiness/events")
      .send({ eventKey: "labels_downloaded" });
    strictEqual(postRes1.status, 201);
    const res2 = await request(app).get("/api/facility-readiness");
    strictEqual(res2.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "interim"); // NOT done

    const postRes2 = await request(app)
      .post("/api/facility-readiness/events")
      .send({ eventKey: "labels_scanned" });
    strictEqual(postRes2.status, 201);
    const res3 = await request(app).get("/api/facility-readiness");
    strictEqual(res3.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "done");
  });

  test("rejects a user with no facility yet", async () => {
    const facilityReadiness = await import("../../routes/facility-readiness");
    const { db, usersTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    const app = createAuthenticatedTestApp(facilityReadiness.default);

    const res = await request(app).get("/api/facility-readiness");
    strictEqual(res.status, 400);
  });
});

describe("POST /api/facility-readiness/events", { skip: !dbUrl }, () => {
  // See the GET describe above: only `facility_readiness_events` is
  // truncated; the org/facility/user/membership tables are shared reference
  // data that must survive across suites.
  const fixture = useDatabaseFixture(["facility_readiness_events"]);

  async function setup() {
    const facilityReadiness = await import("../../routes/facility-readiness");
    const { db, organizationsTable, facilitiesTable, usersTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    const { organizationId, facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
      { farmName: "Sunrise Greens", facilityName: "Sunrise Greens" },
    );
    return {
      app: createAuthenticatedTestApp(facilityReadiness.default, DEFAULT_TEST_USER, facilityId),
      db,
      organizationId,
      facilityId,
    };
  }

  test("rejects an invalid eventKey", async () => {
    const { app } = await setup();
    const res = await request(app).post("/api/facility-readiness/events").send({ eventKey: "not_a_real_key" });
    strictEqual(res.status, 400);
  });

  test("undo sets undoneAt and reverts the derived skip state", async () => {
    const { app } = await setup();

    const skipRes = await request(app)
      .post("/api/facility-readiness/events")
      .send({ eventKey: "sensors_skipped" });
    strictEqual(skipRes.status, 201);
    const afterSkip = await request(app).get("/api/facility-readiness");
    strictEqual(
      afterSkip.body.items.find((i: { key: string }) => i.key === "sensors_registered").state,
      "skipped",
    );

    const undoRes = await request(app)
      .post("/api/facility-readiness/events")
      .send({ eventKey: "sensors_skipped", undo: true });
    strictEqual(undoRes.status, 200);
    const afterUndo = await request(app).get("/api/facility-readiness");
    strictEqual(
      afterUndo.body.items.find((i: { key: string }) => i.key === "sensors_registered").state,
      "pending",
    );
  });

  test("rejects a user with no facility yet", async () => {
    const facilityReadiness = await import("../../routes/facility-readiness");
    const { db, usersTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    const app = createAuthenticatedTestApp(facilityReadiness.default);

    const res = await request(app).post("/api/facility-readiness/events").send({ eventKey: "team_invited" });
    strictEqual(res.status, 400);
  });
});
