import { describe, test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  closeDatabasePoolAfterTests,
  getAdminDb,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * GET /tasks status-filter semantics (Release 1 Task 6).
 *
 * The route has two mutually-exclusive branches: an explicit valid status
 * (`pending` | `in_progress` | `done`) filters by `eq(status)` only; an
 * absent/invalid status falls back to `isNull(completedAt)` (open tasks only).
 * The bug they replace was that `isNull(completedAt)` was ALWAYS pushed into
 * the where-clause, so `?status=done` ANDed "status = done" with
 * "completedAt IS NULL" — impossible for any row to satisfy, so the endpoint
 * always returned zero rows for done tasks.
 *
 * Gated on TEST_DATABASE_URL (mirrors the metrics suites + smoke test): skips
 * cleanly in a database-less run rather than erroring or hanging. Both the
 * router and `@workspace/db` are imported lazily inside a `setup()` helper so
 * the file loads (and skips) even when DATABASE_URL/TEST_DATABASE_URL are
 * unset — the production `@workspace/db` module throws at load time without a
 * connection string.
 */
describe(
  "GET /tasks status filter",
  { skip: !requireTestDatabaseUrl() },
  () => {
    // Truncate `tasks` before the suite AND before each test (see
    // useDatabaseFixture's beforeEach) — cycleId/userId are nullable FKs
    // (safe to omit in the fixture rows below), and nothing else this suite
    // touches.
    const fixture = useDatabaseFixture(["tasks"]);

    async function setup() {
      // Lazily imported: pulls in `@workspace/db` (opens the module-level Pool
      // against TEST_DATABASE_URL, set by the fixture's `before` hook). Safe
      // because this only runs inside a non-skipped describe.
      const tasks = await import("../../routes/tasks");
      const {
        db,
        tasksTable,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
      );
      return {
        app: createAuthenticatedTestApp(tasks.default, DEFAULT_TEST_USER, facilityId),
        db,
        tasksTable,
        facilityId,
      };
    }

    const PENDING = {
      type: "inspect" as const,
      status: "pending" as const,
      assignee: null,
      dueAt: null,
      completedAt: null,
    };
    const DONE = {
      type: "harvest" as const,
      status: "done" as const,
      assignee: null,
      dueAt: null,
      completedAt: new Date("2024-01-01T00:00:00Z"),
    };

    test("default (no status) returns only open tasks", async () => {
      const { app, db, tasksTable, facilityId } = await setup();
      await (getAdminDb() ?? db).insert(tasksTable).values([
        { ...PENDING, facilityId },
        { ...DONE, facilityId },
      ]);

      const res = await request(app).get("/api/tasks");

      strictEqual(res.status, 200);
      // Default behavior = isNull(completedAt) = open tasks only, so the done
      // task (completedAt set) must be excluded; the pending one returned.
      strictEqual(res.body.length, 1);
      strictEqual(res.body[0].status, "pending");
      strictEqual(res.body[0].completedAt, null);
    });

    test("status=done returns the completed task", async () => {
      const { app, db, tasksTable, facilityId } = await setup();
      await (getAdminDb() ?? db).insert(tasksTable).values([
        { ...PENDING, facilityId },
        { ...DONE, facilityId },
      ]);

      const res = await request(app).get("/api/tasks").query({ status: "done" });

      strictEqual(res.status, 200);
      // The regression: status=done used to AND "status = done" with
      // "completedAt IS NULL", returning zero rows. It must now return the one
      // done task (which has completedAt set).
      strictEqual(res.body.length, 1);
      strictEqual(res.body[0].status, "done");
      deepStrictEqual(res.body[0].completedAt, "2024-01-01T00:00:00.000Z");
    });

    test("status=pending returns only pending tasks", async () => {
      const { app, db, tasksTable, facilityId } = await setup();
      await (getAdminDb() ?? db).insert(tasksTable).values([
        { ...PENDING, facilityId },
        { ...DONE, facilityId },
      ]);

      const res = await request(app)
        .get("/api/tasks")
        .query({ status: "pending" });

      strictEqual(res.status, 200);
      strictEqual(res.body.length, 1);
      strictEqual(res.body[0].status, "pending");
    });

    test("status=in_progress filters by status (no false isNull clause)", async () => {
      const { app, db, tasksTable, facilityId } = await setup();
      await (getAdminDb() ?? db).insert(tasksTable).values([
        { ...PENDING, facilityId },
        { ...DONE, facilityId },
        {
          type: "transplant" as const,
          status: "in_progress" as const,
          assignee: null,
          dueAt: null,
          completedAt: null,
          facilityId,
        },
      ]);

      const res = await request(app)
        .get("/api/tasks")
        .query({ status: "in_progress" });

      strictEqual(res.status, 200);
      strictEqual(res.body.length, 1);
      strictEqual(res.body[0].status, "in_progress");
    });

    test("invalid status falls back to open-tasks default", async () => {
      const { app, db, tasksTable, facilityId } = await setup();
      await (getAdminDb() ?? db).insert(tasksTable).values([
        { ...PENDING, facilityId },
        { ...DONE, facilityId },
      ]);

      const res = await request(app)
        .get("/api/tasks")
        .query({ status: "bogus" });

      strictEqual(res.status, 200);
      // An invalid status is treated like an absent one: open tasks only.
      strictEqual(res.body.length, 1);
      strictEqual(res.body[0].status, "pending");
    });
  },
);
