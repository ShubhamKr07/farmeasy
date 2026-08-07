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
 * Task 2, TEN-001/TEN-003; multi-facility support TEN-008 Task 7; org
 * provisioning moved out TEN-012 Task 5).
 *
 * TEN-012: POST /facilities NO LONGER creates the organization — every
 * account's org is provisioned lazily at the first authed wizard bootstrap
 * (ensureOwnerOrg, from GET /wizard/progress), which always runs before W2.
 * POST /facilities now just resolves the user's already-existing active
 * organization_members row and creates the facility + its 3 index-1 rooms
 * (seeding/fertigation/harvesting) in one transaction; a user with NO
 * membership gets a 500 guard ("No organization for user") that should never
 * fire post-bootstrap. These tests therefore seed an active owner membership
 * first (via `seedOwnerOrg`, standing in for that bootstrap step) before every
 * POST. TEN-001's "exactly one organization per user" is unchanged (enforced
 * by organization_members' own unique index on user_id).
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

/**
 * Stands in for the wizard bootstrap (ensureOwnerOrg): creates a fresh
 * organization and an active owner membership for the given user, returning
 * the new org id. TEN-012 moved org creation out of POST /facilities, so W2
 * now requires this row to already exist.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOwnerOrg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adb: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  organizationsTable: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  organizationMembersTable: any,
  userId: string,
  name = "Pre-existing Org",
): Promise<number> {
  const [org] = await adb.insert(organizationsTable).values({ name }).returning();
  await adb.insert(organizationMembersTable).values({
    organizationId: org.id,
    userId,
    role: "owner",
    status: "active",
  });
  return org.id;
}

describe("POST /api/facilities", { skip: !dbUrl }, () => {
  // Only `rooms` is truncated. `organizations`/`facilities`/`users` are shared
  // reference tables the FK graph now fans out through (TRUNCATE ... CASCADE
  // would destroy every cycles/inventory_items/alerts/tasks/shipments/... row
  // — plus the pilot-default facility other suites resolve via
  // `ORDER BY id LIMIT 1`). This suite's own POST always creates a fresh
  // facility under a freshly-seeded org, and every assertion is keyed off the
  // seeded `organizationId` or the returned facilityId — never off these
  // tables being globally empty.
  const fixture = useDatabaseFixture(["rooms"]);

  async function setup() {
    const facilities = await import("../../routes/facilities");
    const { db, roomsTable, usersTable, organizationsTable, organizationMembersTable, wizardProgressTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const adb = getAdminDb() ?? db;
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    // organization_members is a shared table never truncated between test
    // files -- if any other file's seedTenantContext already gave this exact
    // shared synthetic user a membership earlier in the same suite run, a
    // fresh insert would collide on organization_members_user_id_uniq. Delete
    // any pre-existing row for this user first so each test starts from a
    // known state (no membership) and `seedOwnerOrg` can create exactly one.
    await adb.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
    // wizard_progress is also shared/never-truncated-here; GET /facilities'
    // onboarded flag (TEN-008) resolves through it, so clear any row left by
    // an earlier test/file for this same synthetic user.
    await adb.delete(wizardProgressTable).where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable, organizationsTable, organizationMembersTable, adb };
  }

  test("TEN-012: creates only the facility + 3 rooms under the user's existing org (no longer creates the org)", async () => {
    const { app, db, roomsTable, organizationsTable, organizationMembersTable, adb } = await setup();
    const orgId = await seedOwnerOrg(adb, organizationsTable, organizationMembersTable, DEFAULT_TEST_USER.sub);

    const res = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Sunrise Greens", timezone: "America/New_York", units: "imperial", currency: "USD" });

    strictEqual(res.status, 201);
    ok(res.body.facilityId);
    strictEqual(res.body.organizationId, orgId, "the facility must attach to the pre-existing org, not a new one");
    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, res.body.facilityId));
    strictEqual(rooms.length, 3);
  });

  test("TEN-012: reuses the existing org + membership — POST creates no new organization and no new membership row", async () => {
    const { app, organizationsTable, organizationMembersTable, adb } = await setup();
    await seedOwnerOrg(adb, organizationsTable, organizationMembersTable, DEFAULT_TEST_USER.sub);

    const orgsBefore = (await adb.select().from(organizationsTable)).length;
    const membersBefore = (
      await adb.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub))
    ).length;

    const res = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Reuse Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(res.status, 201);

    const orgsAfter = (await adb.select().from(organizationsTable)).length;
    const membersAfter = (
      await adb.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub))
    ).length;
    strictEqual(orgsAfter, orgsBefore, "POST /facilities must not create a new organization");
    strictEqual(membersAfter, membersBefore, "POST /facilities must not create a new membership row");
    strictEqual(membersAfter, 1, "the user still has exactly their one bootstrap owner membership");
  });

  test("TEN-012: 500 'No organization for user' when the user has no membership (guard that should never fire post-bootstrap)", async () => {
    const { app } = await setup(); // membership deleted, none seeded

    const res = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Orphan Farm", timezone: "UTC", units: "metric", currency: "USD" });

    strictEqual(res.status, 500);
    strictEqual(res.body.error, "No organization for user");
  });

  test("POST /facilities: a second facility for an existing org succeeds (TEN-008, no more 409)", async () => {
    const { app, db, roomsTable, organizationsTable, organizationMembersTable, adb } = await setup();
    const orgId = await seedOwnerOrg(adb, organizationsTable, organizationMembersTable, DEFAULT_TEST_USER.sub);

    const firstRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "First Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(firstRes.status, 201);
    strictEqual(firstRes.body.organizationId, orgId);

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
    const { app, organizationsTable, organizationMembersTable, adb } = await setup();
    await seedOwnerOrg(adb, organizationsTable, organizationMembersTable, DEFAULT_TEST_USER.sub);

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
    const { db, roomsTable, usersTable, organizationsTable, organizationMembersTable, wizardProgressTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const adb = getAdminDb() ?? db;
    await seedTestUser(db, usersTable, { id: DEFAULT_TEST_USER.sub, email: "test-user@example.com" });
    // See the POST describe's setup() above for why this delete is needed.
    await adb.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
    // wizard_progress is also a shared table (never truncated by this
    // fixture — only `rooms` is) and, post-TEN-008, is exactly what GET
    // /facilities/me resolves through. Clear any row left by an earlier test
    // in this describe (or another file's use of this same synthetic user)
    // so "returns null" genuinely means "no wizard_progress row", not "a
    // stale one from a previous test happened not to match."
    await adb.delete(wizardProgressTable).where(eq(wizardProgressTable.userId, DEFAULT_TEST_USER.sub));
    return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable, organizationsTable, organizationMembersTable, wizardProgressTable, adb };
  }

  test("returns null when the signed-in user has no facility yet", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 200);
    strictEqual(res.body, null);
  });

  test("returns the user's facility after POST /facilities, once its wizard_progress row reaches done", async () => {
    const { app, db, wizardProgressTable, organizationsTable, organizationMembersTable, adb } = await setup();
    // TEN-012: seed the owner org first (bootstrap stand-in) so W2's POST can
    // attach the facility to it.
    await seedOwnerOrg(adb, organizationsTable, organizationMembersTable, DEFAULT_TEST_USER.sub);

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
