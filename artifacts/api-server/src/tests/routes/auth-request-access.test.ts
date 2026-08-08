import { describe, test } from "node:test";
import { deepStrictEqual, equal } from "node:assert";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  useDatabaseFixture,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * POST /auth/request-access — public flag-off waitlist capture (TEN-012 Task 4).
 *
 * The route is ungated (no auth) and lives on the same `createAuthRouter()`
 * factory as GET /auth/signup-availability (Task 3). It writes ONLY to
 * access_requests — it never calls Supabase auth admin and never creates an
 * org/facility/membership. This suite mirrors the Task 3 harness: mount
 * createAuthRouter() on the test app, use the admin connection for row
 * assertions, and assert auth.users is untouched after a valid submit.
 *
 * Importing @workspace/db throws without DATABASE_URL, and the row
 * assertions + auth.users count need the admin connection, so the whole
 * describe is gated on `admin` (= getAdminDb()). The fixture truncates
 * access_requests before every test so count-based assertions stay
 * order-independent (same convention as the other DB-backed suites).
 */

closeDatabasePoolAfterTests();

const admin = getAdminDb();

describe("POST /auth/request-access", { skip: !admin }, () => {
  useDatabaseFixture(["access_requests"]);

  async function app() {
    const { createAuthRouter } = await import("../../routes/auth");
    // Fresh router per call = isolated rate-limiter store per test.
    return createAuthenticatedTestApp(createAuthRouter());
  }

  async function fetchRow(email: string) {
    const adminDb = getAdminDb()!;
    const { accessRequestsTable } = await import("@workspace/db");
    const rows = await adminDb
      .select()
      .from(accessRequestsTable)
      .where(eq(accessRequestsTable.email, email));
    return rows;
  }

  async function countAuthUsers(): Promise<number> {
    const adminDb = getAdminDb()!;
    const result = await adminDb.execute(
      sql`SELECT count(*)::int AS c FROM auth.users`,
    );
    return Number((result.rows as { c: number }[])[0].c);
  }

  test("valid {email,farmName} -> 201; row stored with lowercased email + farmName", async () => {
    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "founder@Example.COM", farmName: "Acme Farm" });
    equal(res.status, 201);
    deepStrictEqual(res.body, { ok: true });

    const rows = await fetchRow("founder@example.com");
    equal(rows.length, 1);
    equal(rows[0].email, "founder@example.com");
    equal(rows[0].farmName, "Acme Farm");
    equal(rows[0].notifiedAt, null);
  });

  test("second submit same email updates farmName (no dup, notified_at untouched)", async () => {
    const first = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "repeat@example.com", farmName: "First Farm" });
    equal(first.status, 201);

    const second = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "REPEAT@example.com", farmName: "Second Farm" });
    equal(second.status, 201);

    const adminDb = getAdminDb()!;
    const { accessRequestsTable } = await import("@workspace/db");
    const rows = await adminDb.select().from(accessRequestsTable);
    equal(rows.length, 1);
    equal(rows[0].email, "repeat@example.com");
    equal(rows[0].farmName, "Second Farm");
    equal(rows[0].notifiedAt, null);
  });

  test("missing email -> 400", async () => {
    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ farmName: "No Email Farm" });
    equal(res.status, 400);
  });

  test("invalid email -> 400", async () => {
    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "not-an-email", farmName: "Bad Email Farm" });
    equal(res.status, 400);
  });

  test("missing farmName -> 400", async () => {
    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "valid@example.com" });
    equal(res.status, 400);
  });

  test("does NOT create any auth.users row (no account side effects)", async () => {
    const before = await countAuthUsers();

    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "noopauth@example.com", farmName: "No Auth Farm" });
    equal(res.status, 201);

    const after = await countAuthUsers();
    equal(after, before);
  });

  test("mixed-case/whitespace email stored lowercased + trimmed", async () => {
    const res = await request(await app())
      .post("/api/auth/request-access")
      .send({ email: "  Mixed@CASE.io  ", farmName: "Trim Farm" });
    equal(res.status, 201);

    const rows = await fetchRow("mixed@case.io");
    equal(rows.length, 1);
    equal(rows[0].email, "mixed@case.io");
    equal(rows[0].farmName, "Trim Farm");
  });
});
