import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * POST/PATCH /inventory payload validation + concurrency-safe PATCH
 * (Release 1 Task 8).
 *
 * The regressions:
 *   - POST validated only `if (!name)`: it accepted non-numeric / Infinity /
 *     negative `currentQty`/`maxQty` (stringified into a Postgres `numeric`
 *     column → ugly unhandled error), invalid `arrivalDate`, and never checked
 *     `currentQty <= maxQty` at the API layer.
 *   - PATCH built its UPDATE from ONLY the request's own fields, never read
 *     the row's stored values first. So `{currentQty: 9}` on a row whose
 *     stored `maxQty` was 8 updated `currentQty` alone with no cross-field
 *     check, and two concurrent PATCHes (one `currentQty=9`, one `maxQty=8`,
 *     each individually plausible against what its own request believed) raced
 *     with no locking — the second to commit hit the DB's CHECK constraint and
 *     surfaced as an unhandled 500.
 *
 * The fix: strict Zod schemas for per-field validation (finite non-negative
 * numbers, real YYYY-MM-DD dates), and PATCH now locks the row with
 * `SELECT ... FOR UPDATE` inside a transaction, merges the supplied fields
 * onto the locked row's current values, validates the COMPLETE merged
 * `currentQty <= maxQty` state, then updates — so the second concurrent
 * request blocks on the lock, reads the first's already-applied change, and
 * rejects itself with a clean 400 instead of relying on the DB's raw
 * constraint-violation exception.
 *
 * Gated on TEST_DATABASE_URL (mirrors the metrics suites + tasks.test.ts):
 * skips cleanly in a database-less run. The router and `@workspace/db` are
 * imported lazily inside `setup()` so the file loads (and skips) even when
 * DATABASE_URL/TEST_DATABASE_URL are unset — `@workspace/db` throws at load
 * without a connection string.
 */
describe(
  "POST/PATCH /inventory validation + concurrency",
  { skip: !requireTestDatabaseUrl() },
  () => {
    // Truncate `inventory_items` before the suite AND before each test (see
    // useDatabaseFixture's beforeEach) so the per-test inserted seed row is
    // the only one present and count/order assertions stay deterministic.
    const fixture = useDatabaseFixture(["inventory_items"]);

    async function setup() {
      // Lazily imported: pulls in `@workspace/db` (opens the module-level Pool
      // against TEST_DATABASE_URL, set by the fixture's `before` hook). Safe
      // because this only runs inside a non-skipped describe.
      const inventory = await import("../../routes/inventory");
      const {
        db,
        inventoryItemsTable,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { seedTenantContext } = await import("../helpers/testDatabase");
      const { DEFAULT_TEST_USER } = await import("../helpers/testApp");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" },
      );
      return {
        app: createAuthenticatedTestApp(inventory.default),
        db,
        inventoryItemsTable,
        facilityId,
      };
    }

    type Setup = Awaited<ReturnType<typeof setup>>;

    /** Insert a seed row and return its id. */
    async function seed(
      db: Setup["db"],
      table: Setup["inventoryItemsTable"],
      facilityId: number,
      overrides: { name?: string; currentQty?: string; maxQty?: string } = {},
    ): Promise<number> {
      const [row] = await db
        .insert(table)
        .values({
          name: overrides.name ?? "Seed Bag",
          currentQty: overrides.currentQty ?? "5",
          maxQty: overrides.maxQty ?? "10",
          unit: "g",
          facilityId,
        })
        .returning();
      return row.id;
    }

    // ── POST validation ──────────────────────────────────────────────────────

    test("rejects a blank name", async () => {
      const { app } = await setup();
      const res = await request(app).post("/api/inventory").send({ name: "" });
      strictEqual(res.status, 400);
    });

    test("rejects a missing name", async () => {
      const { app } = await setup();
      const res = await request(app).post("/api/inventory").send({});
      strictEqual(res.status, 400);
    });

    test("rejects a non-numeric currentQty", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", currentQty: "abc", maxQty: 10 });
      strictEqual(res.status, 400);
    });

    test("rejects an Infinity currentQty", async () => {
      const { app } = await setup();
      // Send raw JSON: 1e999 round-trips through JSON.parse as Infinity, which
      // JSON.stringify could never produce from an object literal. `.finite()`
      // must reject it with a clean 400 rather than letting it reach Postgres.
      const res = await request(app)
        .post("/api/inventory")
        .type("json")
        .send('{"name":"X","currentQty":1e999,"maxQty":10}');
      strictEqual(res.status, 400);
    });

    test("rejects a negative currentQty", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", currentQty: -5, maxQty: 10 });
      strictEqual(res.status, 400);
    });

    test("rejects a negative maxQty", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", maxQty: -1 });
      strictEqual(res.status, 400);
    });

    test("rejects an invalid arrivalDate (garbage)", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", arrivalDate: "not-a-date" });
      strictEqual(res.status, 400);
    });

    test("rejects an invalid arrivalDate (impossible calendar date)", async () => {
      const { app } = await setup();
      // Matches the YYYY-MM-DD shape but month 13 is not a real date
      // (Date.parse → NaN), so the refine rejects it.
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", arrivalDate: "2024-13-01" });
      strictEqual(res.status, 400);
    });

    test("rejects create with currentQty > maxQty", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/inventory")
        .send({ name: "X", currentQty: 20, maxQty: 10 });
      strictEqual(res.status, 400);
    });

    test("creates a valid item (happy path)", async () => {
      const { app } = await setup();
      const res = await request(app).post("/api/inventory").send({
        name: "Radish Seeds",
        currentQty: 5,
        maxQty: 10,
        unit: "g",
        arrivalDate: "2024-05-01",
      });
      strictEqual(res.status, 201);
      strictEqual(res.body.name, "Radish Seeds");
      strictEqual(res.body.currentQty, 5);
      strictEqual(res.body.maxQty, 10);
      strictEqual(res.body.unit, "g");
      strictEqual(res.body.arrivalDate, "2024-05-01");
    });

    test("creates an item defaulting omitted quantities to 0", async () => {
      const { app } = await setup();
      const res = await request(app).post("/api/inventory").send({ name: "No Qty" });
      strictEqual(res.status, 201);
      strictEqual(res.body.currentQty, 0);
      strictEqual(res.body.maxQty, 0);
    });

    // ── item_code (per-facility short id, Task 5) ──────────────────────────────

    test("assigns a 4-char hex itemCode on create", async () => {
      const { app } = await setup();
      const res = await request(app).post("/api/inventory").send({ name: "Coded Seeds" });
      strictEqual(res.status, 201);
      // generateShortId() yields a lowercase 4-hex-char string (same shape as
      // cycles.shortId / shipments.shortId); the handler surfaces it via
      // formatItem. Not null, exactly 4 hex chars.
      ok(typeof res.body.itemCode === "string", "itemCode must be a string");
      ok(/^[0-9a-f]{4}$/.test(res.body.itemCode), `itemCode "${res.body.itemCode}" is not 4 hex chars`);
    });

    test("assigns distinct itemCodes within the same facility", async () => {
      const { app } = await setup();
      // All three resolve to the pilot-default facility (same handler path),
      // so the composite UNIQUE(facility_id, item_code) + app-layer retry
      // loop must keep them distinct — a collision re-rolls via
      // onConflictDoNothing until the insert returns a row.
      const codes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post("/api/inventory")
          .send({ name: `Item ${i}` });
        strictEqual(res.status, 201, `create ${i} should succeed`);
        ok(typeof res.body.itemCode === "string", `itemCode ${i} must be a string`);
        codes.push(res.body.itemCode);
      }
      strictEqual(new Set(codes).size, codes.length, `itemCodes must be distinct: ${codes.join(",")}`);
    });

    // ── PATCH validation against merged state ────────────────────────────────

    test("rejects PATCH currentQty above stored maxQty", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId, { currentQty: "5", maxQty: "8" });
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ currentQty: 9 }); // 9 > stored 8
      strictEqual(res.status, 400);
    });

    test("rejects PATCH maxQty below stored currentQty", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId, { currentQty: "5", maxQty: "8" });
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ maxQty: 4 }); // stored 5 > 4
      strictEqual(res.status, 400);
    });

    test("rejects empty PATCH", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId);
      const res = await request(app).patch(`/api/inventory/${id}`).send({});
      strictEqual(res.status, 400);
    });

    test("rejects PATCH with an unknown key (strict)", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId);
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ bogus: true });
      strictEqual(res.status, 400);
    });

    test("rejects PATCH non-numeric currentQty", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId);
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ currentQty: "abc" });
      strictEqual(res.status, 400);
    });

    test("PATCH returns 404 for a nonexistent id", async () => {
      const { app } = await setup();
      const res = await request(app)
        .patch("/api/inventory/999999")
        .send({ name: "X" });
      strictEqual(res.status, 404);
    });

    test("PATCH currentQty within stored maxQty succeeds (happy path)", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId, { currentQty: "5", maxQty: "10" });
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ currentQty: 7 }); // 7 <= stored 10
      strictEqual(res.status, 200);
      strictEqual(res.body.currentQty, 7);
      strictEqual(res.body.maxQty, 10);
    });

    test("PATCH can raise maxQty to allow a later currentQty (merged ok)", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      const id = await seed(db, inventoryItemsTable, facilityId, { currentQty: "5", maxQty: "8" });
      const res = await request(app)
        .patch(`/api/inventory/${id}`)
        .send({ maxQty: 12 }); // stored 5 <= 12
      strictEqual(res.status, 200);
      strictEqual(res.body.maxQty, 12);
      strictEqual(res.body.currentQty, 5);
    });

    // ── Concurrency ──────────────────────────────────────────────────────────

    test("two concurrent valid-but-jointly-invalid patches: exactly one wins", async () => {
      const { app, db, inventoryItemsTable, facilityId } = await setup();
      // Stored state at request-send time: currentQty=5, maxQty=10. Each
      // request is individually valid against THAT state:
      //   {currentQty: 9} -> 9 <= 10 ok
      //   {maxQty: 8}     -> 5 <= 8  ok
      // but jointly 9 > 8 violates currentQty <= maxQty.
      const id = await seed(db, inventoryItemsTable, facilityId, {
        currentQty: "5",
        maxQty: "10",
      });

      // Fire both concurrently. With SELECT ... FOR UPDATE, the second to
      // reach the row blocks until the first commits, then reads the first's
      // already-applied change and rejects itself with a clean 400 (instead of
      // the old blind-UPDATE behaviour where the second hit the DB CHECK
      // constraint and surfaced an unhandled 500).
      const [patchA, patchB] = await Promise.all([
        request(app).patch(`/api/inventory/${id}`).send({ currentQty: 9 }),
        request(app).patch(`/api/inventory/${id}`).send({ maxQty: 8 }),
      ]);

      const responses = [patchA, patchB];
      const successes = responses.filter((r) => r.status >= 200 && r.status < 300);
      const clientErrors = responses.filter((r) => r.status >= 400 && r.status < 500);
      const serverErrors = responses.filter((r) => r.status >= 500);

      // Exactly one request applied its change; the other is a clean 4xx
      // validation error. Critically, NO 5xx — that's what the old code
      // produced (unhandled CHECK-constraint exception) and what this fix
      // eliminates.
      strictEqual(successes.length, 1, "exactly one concurrent patch should succeed");
      strictEqual(clientErrors.length, 1, "the loser should be a 4xx validation error");
      strictEqual(serverErrors.length, 0, "no unhandled 5xx allowed");

      // The final persisted row must still satisfy the invariant.
      const [final] = await db
        .select()
        .from(inventoryItemsTable);
      ok(
        Number(final.currentQty) <= Number(final.maxQty),
        `invariant violated: currentQty=${final.currentQty} > maxQty=${final.maxQty}`,
      );
    });
  },
);
