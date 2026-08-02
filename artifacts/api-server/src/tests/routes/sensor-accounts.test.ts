import { describe, test } from "node:test";
import { strictEqual, ok, doesNotMatch } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

/**
 * POST /sensor-accounts + GET /sensor-accounts + POST
 * /sensor-accounts/:id/test-connection (onboarding wizard Task 7,
 * SEN-002/SEN-003).
 *
 * SEN-002 hard rule: a created/listed account's response body must NEVER
 * contain `credentialCiphertext` or the plaintext credential — verified
 * both by explicit field assertions and a `doesNotMatch` scan of the whole
 * serialized body.
 *
 * SEN-003: test-connection never fakes a "connected" result. The vendor
 * adapter allowlist is empty at launch, so every vendor falls through to
 * "pending_integration" honestly.
 *
 * Gated on TEST_DATABASE_URL, mirroring facilities.test.ts/inventory.test.ts:
 * `@workspace/db` and the route module are imported lazily inside `setup()`
 * so this file loads (and skips cleanly) even when no test database is
 * configured.
 *
 * Each `setup()` calls `sensorAccounts.createSensorAccountsRouter()` fresh
 * rather than using the module's default export — same pattern as
 * `recommend.test.ts` calling `createRecommendRouter()` per test. The
 * test-connection route's per-user rate limiter is built inside the
 * factory, so a fresh call gets its own isolated MemoryStore; reusing the
 * cached default-export singleton across describe blocks would let one
 * block's requests count against another's rate-limit budget.
 *
 * The handler reads `usersTable` keyed by the JWT `sub` (`getAuth(req).userId`)
 * and gates every route on `user.organizationId` being set (409 "No facility
 * yet" otherwise) — same class of bug Task 2 hit: `DEFAULT_TEST_USER.sub` has
 * no corresponding `users` row by default, and even a bare seeded `users` row
 * has `organizationId: null` unless explicitly set. `setup()` below seeds
 * BOTH an `organizations` row AND a `users` row linked to it so requests
 * reach the code under test instead of 409ing up front.
 */
const dbUrl = requireTestDatabaseUrl();

describe("POST /api/sensor-accounts", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["sensor_accounts", "organizations", "users"]);

  async function setup() {
    const sensorAccounts = await import("../../routes/sensor-accounts");
    const { db, organizationsTable, usersTable } = await import("@workspace/db");
    const [org] = await db.insert(organizationsTable).values({ name: "Sunrise Greens" }).returning();
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
      organizationId: org.id,
    });
    return { app: createAuthenticatedTestApp(sensorAccounts.createSensorAccountsRouter()), db, org };
  }

  test("never returns the plaintext or ciphertext credential", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });

    strictEqual(res.status, 201);
    strictEqual(res.body.maskedFingerprint, "····1234");
    doesNotMatch(JSON.stringify(res.body), /sk_live_abcdef1234/);
    strictEqual(res.body.credentialCiphertext, undefined);
  });

  test("persists the credential encrypted, not in plaintext", async () => {
    const { app, db } = await setup();
    const res = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });
    strictEqual(res.status, 201);

    const { sensorAccountsTable } = await import("@workspace/db");
    const [row] = await db
      .select()
      .from(sensorAccountsTable)
      .where(eq(sensorAccountsTable.id, res.body.id));
    ok(row.credentialCiphertext);
    doesNotMatch(row.credentialCiphertext, /sk_live_abcdef1234/);
  });

  test("rejects a user with no facility yet", async () => {
    const sensorAccounts = await import("../../routes/sensor-accounts");
    const { db, usersTable } = await import("@workspace/db");
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
    });
    const app = createAuthenticatedTestApp(sensorAccounts.createSensorAccountsRouter());

    const res = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });
    strictEqual(res.status, 409);
  });

  test("rejects an invalid authMethod", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "carrier_pigeon", credential: "sk_live_abcdef1234" });
    strictEqual(res.status, 400);
  });
});

describe("GET /api/sensor-accounts", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["sensor_accounts", "organizations", "users"]);

  async function setup() {
    const sensorAccounts = await import("../../routes/sensor-accounts");
    const { db, organizationsTable, usersTable } = await import("@workspace/db");
    const [org] = await db.insert(organizationsTable).values({ name: "Sunrise Greens" }).returning();
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
      organizationId: org.id,
    });
    return { app: createAuthenticatedTestApp(sensorAccounts.createSensorAccountsRouter()), db, org };
  }

  test("returns an empty list when the org has no sensor accounts yet", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/sensor-accounts");
    strictEqual(res.status, 200);
    ok(Array.isArray(res.body));
    strictEqual(res.body.length, 0);
  });

  test("lists the org's accounts without ciphertext, scoped to the caller's organization", async () => {
    const { app } = await setup();
    const createRes = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });
    strictEqual(createRes.status, 201);

    const res = await request(app).get("/api/sensor-accounts");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 1);
    strictEqual(res.body[0].vendor, "Trolmaster");
    strictEqual(res.body[0].maskedFingerprint, "····1234");
    strictEqual(res.body[0].credentialCiphertext, undefined);
    doesNotMatch(JSON.stringify(res.body), /sk_live_abcdef1234/);
  });

  test("returns an empty list for a user with no facility yet", async () => {
    const sensorAccounts = await import("../../routes/sensor-accounts");
    const { db, usersTable } = await import("@workspace/db");
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
    });
    const app = createAuthenticatedTestApp(sensorAccounts.createSensorAccountsRouter());

    const res = await request(app).get("/api/sensor-accounts");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 0);
  });
});

describe("POST /api/sensor-accounts/:id/test-connection", { skip: !dbUrl }, () => {
  const fixture = useDatabaseFixture(["sensor_accounts", "organizations", "users"]);

  async function setup() {
    const sensorAccounts = await import("../../routes/sensor-accounts");
    const { db, organizationsTable, usersTable } = await import("@workspace/db");
    const [org] = await db.insert(organizationsTable).values({ name: "Sunrise Greens" }).returning();
    await db.insert(usersTable).values({
      id: DEFAULT_TEST_USER.sub,
      email: "test-user@example.com",
      role: "technician",
      organizationId: org.id,
    });
    return { app: createAuthenticatedTestApp(sensorAccounts.createSensorAccountsRouter()), db, org };
  }

  test("falls through to pending_integration honestly (no adapter exists yet, SEN-003)", async () => {
    const { app } = await setup();
    const createRes = await request(app)
      .post("/api/sensor-accounts")
      .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });
    strictEqual(createRes.status, 201);

    const res = await request(app).post(
      `/api/sensor-accounts/${createRes.body.id}/test-connection`,
    );
    strictEqual(res.status, 200);
    strictEqual(res.body.status, "pending_integration");
  });

  test("404s for a sensor account belonging to a different organization", async () => {
    const { app, db } = await setup();
    const { organizationsTable, sensorAccountsTable } = await import("@workspace/db");
    const [otherOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Other Farm" })
      .returning();
    const [otherAccount] = await db
      .insert(sensorAccountsTable)
      .values({
        organizationId: otherOrg.id,
        vendor: "Trolmaster",
        authMethod: "api_key",
        status: "pending_integration",
        maskedFingerprint: "····9999",
        credentialCiphertext: "not-a-real-ciphertext",
      })
      .returning();

    const res = await request(app).post(
      `/api/sensor-accounts/${otherAccount.id}/test-connection`,
    );
    strictEqual(res.status, 404);
  });

  test("404s for a nonexistent sensor account id", async () => {
    const { app } = await setup();
    const res = await request(app).post("/api/sensor-accounts/999999/test-connection");
    strictEqual(res.status, 404);
  });
});
