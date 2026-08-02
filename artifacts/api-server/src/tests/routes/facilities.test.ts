import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import { requireTestDatabaseUrl, useDatabaseFixture, seedTestUser } from "../helpers/testDatabase";

/**
 * POST /facilities + GET /facilities/me (onboarding wizard Task 2, TEN-001/TEN-003).
 *
 * POST /facilities creates an organization, a facility, and the 3 index-1
 * rooms (seeding/fertigation/harvesting) in a single transaction, then
 * assigns the signed-in user to the new organization. A user who already
 * belongs to an organization (via `usersTable.organizationId`) is rejected
 * with 409 — one facility per user, enforced at the API layer since the
 * schema itself allows multiple facilities per organization.
 *
 * Gated on TEST_DATABASE_URL, mirroring inventory.test.ts: the router and
 * `@workspace/db` are imported lazily inside `setup()` so this file loads
 * (and skips cleanly) even when no test database is configured.
 *
 * The handler reads/writes `usersTable` keyed by the JWT `sub`
 * (`getAuth(req).userId`). `public.users.id` has a foreign key to
 * `auth.users.id` (migration `00004_create_auth_profiles.sql`), so
 * `DEFAULT_TEST_USER.sub` — a synthetic id that never went through real
 * Supabase auth signup — needs a matching `auth.users` row before any
 * `public.users` row can reference it. Each `setup()` below calls
 * `seedTestUser` (helpers/testDatabase.ts) to seed both.
 */
const dbUrl = requireTestDatabaseUrl();

describe("POST /api/facilities", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["organizations", "facilities", "rooms", "users"]);

  async function setup() {
    const facilities = await import("../../routes/facilities");
    const { db, roomsTable, usersTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable };
  }

  test("creates an organization, facility, and 3 rooms in one transaction", async () => {
    const { app, db, roomsTable } = await setup();
    const res = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Sunrise Greens", timezone: "America/New_York", units: "imperial", currency: "USD" });

    strictEqual(res.status, 201);
    ok(res.body.facilityId);
    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, res.body.facilityId));
    strictEqual(rooms.length, 3);
  });

  test("rejects a second facility for a user who already has one", async () => {
    const { app } = await setup();
    await request(app).post("/api/facilities").send({ farmName: "First Farm", timezone: "UTC", units: "metric", currency: "USD" });
    const res = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Second Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(res.status, 409);
  });
});

describe("GET /api/facilities/me", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["organizations", "facilities", "rooms", "users"]);

  async function setup() {
    const facilities = await import("../../routes/facilities");
    const { db, roomsTable, usersTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable };
  }

  test("returns null when the signed-in user has no facility yet", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 200);
    strictEqual(res.body, null);
  });

  test("returns the user's facility after POST /facilities", async () => {
    const { app } = await setup();
    const createRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Green Acres", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(createRes.status, 201);

    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 200);
    ok(res.body);
    strictEqual(res.body.id, createRes.body.facilityId);
    strictEqual(res.body.organizationId, createRes.body.organizationId);
    strictEqual(res.body.facilityName, "Green Acres");
    strictEqual(res.body.timezone, "UTC");
    strictEqual(res.body.units, "metric");
    strictEqual(res.body.currency, "USD");
  });
});
