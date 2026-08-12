import { describe, test, before, after } from "node:test";
import { deepStrictEqual } from "node:assert";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * GET /auth/signup-availability — public sign-up gating (TEN-011/TEN-012).
 *
 * The router is ungated (no auth) and builds its OWN rate limiter inside the
 * `createAuthRouter()` factory (mirrors wizard-events.ts), so each test gets
 * an isolated MemoryStore — one suite's requests never count against
 * another's budget.
 *
 * TEN-011: `getSignupMode()` is now DB-authoritative (reads the
 * `signup_config` singleton row, not `process.env.SIGNUP_MODE`) — the SAME
 * row the `before_user_created` hook (00025_signup_enforcement.sql) reads,
 * so this endpoint's answer and real enforcement can never drift. Every test
 * below sets the mode via a direct UPDATE on `signup_config` (not the env)
 * to prove that. `signup_config` is a singleton (id=1, seeded by
 * 0034_signup_config.sql) — it is never in `useDatabaseFixture`'s truncate
 * list (truncating a `default 1`, non-serial PK singleton would just delete
 * the only row with no auto-reseed); `setMode` below UPDATEs it in place and
 * `before`/`after` restore it to 'off' (the seeded default) so this file
 * never leaks a non-default mode to a later test file.
 *
 * Importing the router pulls in `@workspace/db` (which throws without
 * DATABASE_URL), so every describe is gated on TEST_DATABASE_URL. The
 * allowlist cases additionally seed `signup_allowlist` directly (no HTTP
 * request sets RLS context for that table) via the admin connection, hence
 * the extra `{ skip: !admin }` gate on the DB-touching describe.
 *
 * The unauthenticated-style harness choice: `createAuthenticatedTestApp`
 * injects an inert identity this endpoint never reads, but it's still the
 * right harness — it mirrors app.ts's JSON parsing + req.log wiring, the
 * same way invitationsAccept.test.ts uses it for its own ungated
 * /invitations/accept route. resolveTenantContext short-circuits without a
 * X-Facility-Id header, so it never runs a DB query here.
 */

closeDatabasePoolAfterTests();

const dbUrl = requireTestDatabaseUrl();
const admin = getAdminDb();

async function setMode(mode: "off" | "allowlist" | "public") {
  const { signupConfigTable, db } = await import("@workspace/db");
  const database = getAdminDb() ?? db;
  await database
    .update(signupConfigTable)
    .set({ mode })
    .where(eq(signupConfigTable.id, 1));
}

describe("GET /auth/signup-availability — signup_config mode (DB-authoritative, TEN-011)", { skip: !dbUrl }, () => {
  // signup_allowlist truncated per test; signup_config is the singleton and
  // is restored (not truncated) via setMode in before/after below.
  useDatabaseFixture(["signup_allowlist"]);

  before(async () => {
    await setMode("off");
  });
  after(async () => {
    await setMode("off");
  });

  async function app() {
    const { createAuthRouter } = await import("../../routes/auth");
    // Fresh router per call = isolated rate-limiter store per test.
    return createAuthenticatedTestApp(createAuthRouter());
  }

  test("signup_config.mode='off' -> { mode:'off', allowed:false }", async () => {
    await setMode("off");
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });

  test("signup_config.mode='public' -> { mode:'public', allowed:true }", async () => {
    await setMode("public");
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "public", allowed: true });
  });
});

// allowlist mode — DB-backed lookup. Seeding writes directly to
// signup_allowlist (no app request carries RLS context for it), so the admin
// connection is required.
describe("GET /auth/signup-availability — signup_config mode allowlist (DB)", { skip: !admin }, () => {
  useDatabaseFixture(["signup_allowlist"]);

  before(async () => {
    await setMode("allowlist");
  });
  after(async () => {
    await setMode("off");
  });

  const SEEDED_EMAIL = "tester@example.com";

  async function app() {
    const { createAuthRouter } = await import("../../routes/auth");
    return createAuthenticatedTestApp(createAuthRouter());
  }

  // beforeEach truncates signup_allowlist (via the fixture), so re-seed the
  // canonical allowlisted row before each assertion. Stored lowercased — the
  // mixed-case/whitespace request input must still match it after normalize.
  async function seedAllowlistedEmail() {
    const adminDb = getAdminDb()!;
    const { signupAllowlistTable } = await import("@workspace/db");
    await adminDb.insert(signupAllowlistTable).values({ email: SEEDED_EMAIL });
  }

  test("allowlist + seeded email (mixed-case/whitespace input) -> allowed:true", async () => {
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: " Tester@Example.com " });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: true });
  });

  test("allowlist + absent email -> allowed:false", async () => {
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: "nobody@example.com" });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });

  test("allowlist + whitespace-only email param -> allowed:false", async () => {
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: "   " });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });

  test("allowlist + no email param -> allowed:false", async () => {
    await seedAllowlistedEmail();
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });
});

// TEN-011 Task 3 Step 2: prove availability tracks signup_config, NOT the
// env — the key single-source-of-truth regression guard. A stale/misleading
// SIGNUP_MODE env value must be ignored once the DB row exists.
describe("GET /auth/signup-availability — reflects signup_config, not SIGNUP_MODE env", { skip: !dbUrl }, () => {
  useDatabaseFixture(["signup_allowlist"]);

  let savedEnvMode: string | undefined;
  before(async () => {
    savedEnvMode = process.env.SIGNUP_MODE;
    await setMode("off");
  });
  after(async () => {
    if (savedEnvMode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = savedEnvMode;
    await setMode("off");
  });

  async function app() {
    const { createAuthRouter } = await import("../../routes/auth");
    return createAuthenticatedTestApp(createAuthRouter());
  }

  test("env SIGNUP_MODE='public' is IGNORED while signup_config.mode='off'", async () => {
    process.env.SIGNUP_MODE = "public";
    await setMode("off");
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });

  test("env SIGNUP_MODE='off' is IGNORED while signup_config.mode='public'", async () => {
    process.env.SIGNUP_MODE = "off";
    await setMode("public");
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "public", allowed: true });
  });
});
