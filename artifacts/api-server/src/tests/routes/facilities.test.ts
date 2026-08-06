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
  getAdminDb,
} from "../helpers/testDatabase";

/**
 * POST /facilities + GET /facilities + GET /facilities/me (onboarding wizard
 * Task 2, TEN-001/TEN-003; multi-facility support TEN-008 Task 7).
 *
 * POST /facilities creates an organization (first-time only), a facility,
 * and the 3 index-1 rooms (seeding/fertigation/harvesting) in a single
 * transaction. Post-TEN-008, a user with an existing active
 * organization_members row ("Add facility") reuses that same organization
 * for the new facility instead of being rejected — the one-facility-per-org
 * 409 gate is gone; TEN-001's "exactly one organization per user" is
 * unchanged (still enforced by organization_members' own unique index on
 * user_id).
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
closeDatabasePoolAfterTests();

describe("POST /api/facilities", { skip: !dbUrl }, () => {
  // Only `rooms` is truncated. `organizations`/`facilities`/`users` are shared
  // reference tables the FK graph now fans out through (TRUNCATE ... CASCADE
  // would destroy every cycles/inventory_items/alerts/tasks/shipments/... row
  // — plus the pilot-default facility other suites resolve via
  // `ORDER BY id LIMIT 1`). This suite's own POST always creates a fresh
  // org+facility, and every assertion is keyed off the signed-in test user's
  // own `organizationId` (reset to null by seedTestUser each setup) or the
  // returned facilityId — never off these tables being globally empty.
  const fixture = useDatabaseFixture(["rooms"]);

  async function setup() {
    const facilities = await import("../../routes/facilities");
    const { db, roomsTable, usersTable, organizationMembersTable, wizardProgressTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    // POST /facilities plain-inserts into organization_members (no upsert --
    // a real user only ever gets one membership, created once). Unlike
    // users.organization_id (reset above by seedTestUser), organization_members
    // is a shared table never truncated between test files -- if ANY other
    // file's seedTenantContext call already gave this exact shared synthetic
    // user a membership earlier in the same suite run, this insert collides
    // on organization_members_user_id_uniq even though users.organization_id
    // looks fresh. Delete any pre-existing row for this user first so this
    // suite's own correctness doesn't depend on running before every other
    // file that uses DEFAULT_TEST_USER.sub (Task 16, MT-M1).
    await (getAdminDb() ?? db).delete(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
    // wizard_progress is also shared/never-truncated-here; GET /facilities'
    // onboarded flag (TEN-008) resolves through it, so clear any row left by
    // an earlier test/file for this same synthetic user.
    await (getAdminDb() ?? db).delete(wizardProgressTable).where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
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

  test("POST /facilities: a second facility for an existing org succeeds (TEN-008, no more 409)", async () => {
    const { app, db, roomsTable } = await setup();
    const firstRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "First Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(firstRes.status, 201);

    const secondRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Second Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(secondRes.status, 201, "a second facility for the same org must now succeed");
    strictEqual(
      secondRes.body.organizationId,
      firstRes.body.organizationId,
      "the second facility must belong to the SAME organization, not a new one",
    );

    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, secondRes.body.facilityId));
    strictEqual(rooms.length, 3, "the second facility gets its own 3 default rooms too");
  });

  test("GET /facilities: lists every facility for the signed-in user's organization", async () => {
    const { app } = await setup();
    await request(app)
      .post("/api/facilities")
      .send({ farmName: "Farm One", timezone: "UTC", units: "metric", currency: "USD" });
    await request(app)
      .post("/api/facilities")
      .send({ farmName: "Farm Two", timezone: "UTC", units: "metric", currency: "USD" });

    const res = await request(app).get("/api/facilities");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 2);
    ok(res.body.every((f: { onboarded: boolean }) => f.onboarded === false), "neither facility has completed its wizard yet");
  });
});

describe("GET /api/facilities/me", { skip: !dbUrl }, () => {
  // See the POST describe above: only `rooms` is truncated; the org/facility/
  // user tables are shared reference data that must survive across suites.
  const fixture = useDatabaseFixture(["rooms"]);

  async function setup() {
    const facilities = await import("../../routes/facilities");
    const { db, roomsTable, usersTable, organizationMembersTable, wizardProgressTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    // See the POST describe's setup() above for why this delete is needed.
    await (getAdminDb() ?? db).delete(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
    // wizard_progress is also a shared table (never truncated by this
    // fixture — only `rooms` is) and, post-TEN-008, is exactly what GET
    // /facilities/me resolves through. Clear any row left by an earlier test
    // in this describe (or another file's use of this same synthetic user)
    // so "returns null" genuinely means "no wizard_progress row", not "a
    // stale one from a previous test happened not to match."
    await (getAdminDb() ?? db).delete(wizardProgressTable).where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable, wizardProgressTable };
  }

  test("returns null when the signed-in user has no facility yet", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 200);
    strictEqual(res.body, null);
  });

  test("returns the user's facility after POST /facilities, once its wizard_progress row reaches done", async () => {
    const { app, db, wizardProgressTable } = await setup();
    const createRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Green Acres", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(createRes.status, 201);

    // GET /facilities/me (TEN-008) resolves via the user's own wizard_progress
    // row, not "the org's facility" — Done.tsx (its only real caller) only
    // ever renders once that facility's wizard reached the `done` step, so
    // seed exactly that row directly rather than going through every wizard
    // step's PUT call.
    await db.insert(wizardProgressTable).values({
      userId: DEFAULT_TEST_USER.sub,
      organizationId: createRes.body.organizationId,
      facilityId: createRes.body.facilityId,
      currentStep: "done",
      stepData: {},
    });

    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 200);
    ok(res.body);
    strictEqual(res.body.id, createRes.body.facilityId);
    strictEqual(res.body.organizationId, createRes.body.organizationId);
    strictEqual(res.body.facilityName, "Green Acres");
    strictEqual(res.body.timezone, "UTC");
    strictEqual(res.body.units, "metric");
    strictEqual(res.body.currency, "USD");
    strictEqual(res.body.onboarded, true);
  });
});
