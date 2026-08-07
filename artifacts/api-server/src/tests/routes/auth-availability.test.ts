import { describe, test, before, after } from "node:test";
import { deepStrictEqual } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * GET /auth/signup-availability — public sign-up gating (TEN-012 Task 3).
 *
 * The router is ungated (no auth) and builds its OWN rate limiter inside the
 * `createAuthRouter()` factory (mirrors wizard-events.ts), so each test gets
 * an isolated MemoryStore — one suite's requests never count against
 * another's budget. The handler branches on `process.env.SIGNUP_MODE` at
 * request time, so each test sets/restores it.
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

// SIGNUP_MODE off/public — no DB query is reached (the handler returns before
// the allowlist lookup), but importing the router needs DATABASE_URL.
describe("GET /auth/signup-availability — SIGNUP_MODE off/public", { skip: !dbUrl }, () => {
  // Sets DATABASE_URL + imports @workspace/db before the dynamic router
  // import inside `app()`; the truncate is harmless for these cases.
  useDatabaseFixture(["signup_allowlist"]);

  let savedMode: string | undefined;
  before(() => {
    savedMode = process.env.SIGNUP_MODE;
  });
  after(() => {
    if (savedMode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = savedMode;
  });

  async function app() {
    const { createAuthRouter } = await import("../../routes/auth");
    // Fresh router per call = isolated rate-limiter store per test.
    return createAuthenticatedTestApp(createAuthRouter());
  }

  test("SIGNUP_MODE unset -> { mode:'off', allowed:false }", async () => {
    delete process.env.SIGNUP_MODE;
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });

  test("SIGNUP_MODE='off' -> { mode:'off', allowed:false }", async () => {
    process.env.SIGNUP_MODE = "off";
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });

  test("SIGNUP_MODE='OFF' (case-insensitive) -> { mode:'off', allowed:false }", async () => {
    process.env.SIGNUP_MODE = "OFF";
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });

  test("SIGNUP_MODE='public' -> { mode:'public', allowed:true }", async () => {
    process.env.SIGNUP_MODE = "public";
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "public", allowed: true });
  });

  test("SIGNUP_MODE='garbage' -> defaults to off", async () => {
    process.env.SIGNUP_MODE = "totally-unknown-value";
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "off", allowed: false });
  });
});

// allowlist mode — DB-backed lookup. Seeding writes directly to
// signup_allowlist (no app request carries RLS context for it), so the admin
// connection is required.
describe("GET /auth/signup-availability — SIGNUP_MODE allowlist (DB)", { skip: !admin }, () => {
  useDatabaseFixture(["signup_allowlist"]);

  let savedMode: string | undefined;
  before(() => {
    savedMode = process.env.SIGNUP_MODE;
  });
  after(() => {
    if (savedMode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = savedMode;
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
    process.env.SIGNUP_MODE = "allowlist";
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: " Tester@Example.com " });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: true });
  });

  test("allowlist + absent email -> allowed:false", async () => {
    process.env.SIGNUP_MODE = "allowlist";
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: "nobody@example.com" });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });

  test("allowlist + whitespace-only email param -> allowed:false", async () => {
    process.env.SIGNUP_MODE = "allowlist";
    await seedAllowlistedEmail();
    const res = await request(await app())
      .get("/api/auth/signup-availability")
      .query({ email: "   " });
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });

  test("allowlist + no email param -> allowed:false", async () => {
    process.env.SIGNUP_MODE = "allowlist";
    await seedAllowlistedEmail();
    const res = await request(await app()).get("/api/auth/signup-availability");
    deepStrictEqual(res.body, { mode: "allowlist", allowed: false });
  });
});
