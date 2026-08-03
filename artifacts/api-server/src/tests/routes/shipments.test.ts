import { describe, test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * GET /shipments filtered keyset pagination (Release 1 Task 7).
 *
 * The regression: the handler ran the keyset query
 * (`where(id > cursor).orderBy(id).limit(limit + 1)`) FIRST, then applied
 * status/client as JS `.filter()` on the already-truncated result set. When
 * enough non-matching rows preceded the first match in id order, the matches
 * sat beyond the limit+1 window and never left the DB — so they silently
 * vanished from filtered results, and `hasMore`/`nextCursor` were computed
 * from the wrong (post-filter, already-truncated) set, breaking pagination for
 * any filtered query.
 *
 * The fix pushes status (`eq`) and client (`ilike`, escaped literal substring)
 * into the SQL WHERE clause alongside the cursor condition, all BEFORE
 * `.limit(limit + 1)`. These tests seed the exact scenario that exposes the
 * bug — matches appearing AFTER non-matches in id order, beyond a small
 * limit+1 window — and assert the matches are still returned and paginated.
 *
 * Gated on TEST_DATABASE_URL (mirrors the metrics suites + tasks.test.ts):
 * skips cleanly in a database-less run. The router and `@workspace/db` are
 * imported lazily inside `setup()` so the file loads (and skips) even when
 * DATABASE_URL/TEST_DATABASE_URL are unset — `@workspace/db` throws at load
 * without a connection string.
 */
describe(
  "GET /shipments filtered keyset pagination",
  { skip: !requireTestDatabaseUrl() },
  () => {
    // Truncate `shipments` before the suite AND before each test (see
    // useDatabaseFixture's beforeEach) so count-based assertions stay
    // order-independent within this file. Nothing else is touched.
    const fixture = useDatabaseFixture(["shipments"]);

    async function setup() {
      // Lazily imported: pulls in `@workspace/db` (opens the module-level Pool
      // against TEST_DATABASE_URL, set by the fixture's `before` hook). Safe
      // because this only runs inside a non-skipped describe.
      const shipments = await import("../../routes/shipments");
      const { db, shipmentsTable } = await import("@workspace/db");
      return {
        app: createAuthenticatedTestApp(shipments.default),
        db,
        shipmentsTable,
      };
    }

    /** Minimal insert rows — shortId is unique per insert (serial id is the cursor). */
    function shipment(shortId: string, client: string, status: "pending" | "in_progress" | "complete") {
      return { shortId, client, status };
    }

    test("status filter returns matches appearing after non-matches beyond the window", async () => {
      const { app, db, shipmentsTable } = await setup();
      // Non-matches first (ids 1-3), then the matching complete rows (ids 4-5).
      // With limit=2 the limit+1 window is 3 rows; the OLD code fetched ids
      // 1-3 (all pending), `.filter(status=complete)` dropped every one, and
      // returned []. The matches (ids 4-5) never left the DB.
      await db.insert(shipmentsTable).values([
        shipment("SHP-PND-1", "Acme", "pending"),
        shipment("SHP-PND-2", "Acme", "pending"),
        shipment("SHP-PND-3", "Acme", "pending"),
        shipment("SHP-CMP-1", "Acme", "complete"),
        shipment("SHP-CMP-2", "Acme", "complete"),
      ]);

      const res = await request(app)
        .get("/api/shipments")
        .query({ status: "complete", limit: "2" });

      strictEqual(res.status, 200);
      // The complete rows must be returned despite living past the limit+1
      // window of non-matching pending rows.
      strictEqual(res.body.items.length, 2);
      deepStrictEqual(
        res.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-CMP-1", "SHP-CMP-2"],
      );
      for (const item of res.body.items) {
        strictEqual(item.status, "complete");
      }
      // Only 2 matches exist and both fit in the page → no next page.
      strictEqual(res.body.nextCursor, null);
    });

    test("status filter paginates correctly across multiple filtered pages", async () => {
      const { app, db, shipmentsTable } = await setup();
      // 4 non-matching pending rows (ids 1-4), then 4 matching complete rows
      // (ids 5-8). With limit=2 we expect two pages of complete rows.
      await db.insert(shipmentsTable).values([
        shipment("SHP-PND-1", "Acme", "pending"),
        shipment("SHP-PND-2", "Acme", "pending"),
        shipment("SHP-PND-3", "Acme", "pending"),
        shipment("SHP-PND-4", "Acme", "pending"),
        shipment("SHP-CMP-1", "Acme", "complete"),
        shipment("SHP-CMP-2", "Acme", "complete"),
        shipment("SHP-CMP-3", "Acme", "complete"),
        shipment("SHP-CMP-4", "Acme", "complete"),
      ]);

      // Page 1: limit+1 = 3 matched rows fetched (ids 5,6,7) → hasMore.
      const page1 = await request(app)
        .get("/api/shipments")
        .query({ status: "complete", limit: "2" });

      strictEqual(page1.status, 200);
      deepStrictEqual(
        page1.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-CMP-1", "SHP-CMP-2"],
      );
      // nextCursor is the last id of the returned page, not the truncated set.
      strictEqual(page1.body.nextCursor, page1.body.items[1].id);

      // Page 2: WHERE status='complete' AND id > <cursor> → ids 7,8 only.
      const page2 = await request(app)
        .get("/api/shipments")
        .query({ status: "complete", limit: "2", cursor: String(page1.body.nextCursor) });

      strictEqual(page2.status, 200);
      deepStrictEqual(
        page2.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-CMP-3", "SHP-CMP-4"],
      );
      // Last filtered page → no next cursor.
      strictEqual(page2.body.nextCursor, null);
    });

    test("client filter is a case-insensitive substring returning matches after non-matches", async () => {
      const { app, db, shipmentsTable } = await setup();
      // Non-matching clients first (ids 1-3), then matching "Globex" rows (4-5).
      await db.insert(shipmentsTable).values([
        shipment("SHP-A-1", "Acme Corp", "pending"),
        shipment("SHP-A-2", "Acme Corp", "pending"),
        shipment("SHP-A-3", "Acme Corp", "pending"),
        shipment("SHP-G-1", "Globex Inc", "complete"),
        shipment("SHP-G-2", "Globex Inc", "complete"),
      ]);

      // Lowercase query against mixed-case stored value → case-insensitive.
      const res = await request(app)
        .get("/api/shipments")
        .query({ client: "globex", limit: "2" });

      strictEqual(res.status, 200);
      deepStrictEqual(
        res.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-G-1", "SHP-G-2"],
      );
      for (const item of res.body.items) {
        strictEqual(item.client, "Globex Inc");
      }
    });

    test("client filter escapes LIKE metacharacters — % matches a literal %, not everything", async () => {
      const { app, db, shipmentsTable } = await setup();
      // Rows with no literal % first (ids 1-3), then rows that DO contain a
      // literal % (ids 4-5). Searching for client="%" must return only the two
      // rows containing a literal %, NOT every row (the unescaped `%%%` would
      // match all five).
      await db.insert(shipmentsTable).values([
        shipment("SHP-N1", "Acme", "pending"),
        shipment("SHP-N2", "Beta", "pending"),
        shipment("SHP-N3", "Gamma", "pending"),
        shipment("SHP-P1", "100% Pure", "complete"),
        shipment("SHP-P2", "Discount 50%", "complete"),
      ]);

      const res = await request(app)
        .get("/api/shipments")
        .query({ client: "%", limit: "2" });

      strictEqual(res.status, 200);
      deepStrictEqual(
        res.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-P1", "SHP-P2"],
      );
      for (const item of res.body.items) {
        strictEqual(item.client.includes("%"), true);
      }
    });

    test("client filter escapes the underscore wildcard as a literal", async () => {
      const { app, db, shipmentsTable } = await setup();
      // "AB Farm" contains "B Farm" (one char + " Farm"? no — test the literal
      // underscore). Searching "_" must match only rows with a literal _, not
      // every single-char-then-anything row.
      await db.insert(shipmentsTable).values([
        shipment("SHP-U1", "Acme", "pending"),
        shipment("SHP-U2", "Beta", "pending"),
        shipment("SHP-U3", "Test_Farm", "complete"),
      ]);

      const res = await request(app)
        .get("/api/shipments")
        .query({ client: "_", limit: "2" });

      strictEqual(res.status, 200);
      deepStrictEqual(
        res.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-U3"],
      );
    });

    test("combined status + client filter before the limit window", async () => {
      const { app, db, shipmentsTable } = await setup();
      // Non-matches (wrong client, pending) first, then matching rows
      // (Globex + complete) at the tail beyond the limit+1 window.
      await db.insert(shipmentsTable).values([
        shipment("SHP-X1", "Acme", "pending"),
        shipment("SHP-X2", "Acme", "pending"),
        shipment("SHP-X3", "Globex", "pending"), // right client, wrong status
        shipment("SHP-X4", "Acme", "complete"), // right status, wrong client
        shipment("SHP-X5", "Globex", "complete"), // matches BOTH
        shipment("SHP-X6", "Globex", "complete"), // matches BOTH
      ]);

      const res = await request(app)
        .get("/api/shipments")
        .query({ status: "complete", client: "globex", limit: "2" });

      strictEqual(res.status, 200);
      deepStrictEqual(
        res.body.items.map((i: { shortId: string }) => i.shortId),
        ["SHP-X5", "SHP-X6"],
      );
    });

    test("no filter + no cursor/limit keeps the legacy flat-array shape", async () => {
      const { app, db, shipmentsTable } = await setup();
      await db.insert(shipmentsTable).values([
        shipment("SHP-1", "Acme", "pending"),
        shipment("SHP-2", "Acme", "complete"),
      ]);

      const res = await request(app).get("/api/shipments");

      strictEqual(res.status, 200);
      strictEqual(Array.isArray(res.body), true);
      strictEqual(res.body.length, 2);
      deepStrictEqual(
        res.body.map((i: { shortId: string }) => i.shortId),
        ["SHP-1", "SHP-2"],
      );
    });

    test("invalid status is ignored (no filter applied)", async () => {
      const { app, db, shipmentsTable } = await setup();
      await db.insert(shipmentsTable).values([
        shipment("SHP-1", "Acme", "pending"),
        shipment("SHP-2", "Acme", "complete"),
      ]);

      const res = await request(app)
        .get("/api/shipments")
        .query({ status: "bogus", limit: "2" });

      strictEqual(res.status, 200);
      // Bogus status = no filter → both rows returned (limit+1=3 ≥ 2).
      strictEqual(res.body.items.length, 2);
    });
  },
);
