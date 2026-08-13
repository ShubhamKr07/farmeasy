// artifacts/api-server/src/tests/app.test.ts
import { describe, test, before, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  requireTestDatabaseUrl,
  seedTenantContext,
  closeDatabasePoolAfterTests,
} from "./helpers/testDatabase";

/**
 * Real app.ts integration test (Task 12.5 regression).
 *
 * Every other test file in this repo (see helpers/testApp.ts's
 * createAuthenticatedTestApp) builds its own standalone Express app that
 * mounts a caller-supplied router directly, with none of app.ts's own
 * per-router requireSignedIn/requireTenantContext wrapping replicated -- so
 * the REAL `app` object (artifacts/api-server/src/app.ts's default export)
 * has never been exercised by any test. That gap is exactly how the
 * mount-ordering bug this file exists to catch went undetected: Express's
 * `app.use(path, mw1, mw2, router)` runs `mw1`/`mw2` for EVERY request whose
 * path matches `path` (a prefix match, and every router here shares the
 * "/api" prefix) that reaches that point in the stack -- not just requests
 * `router` itself would actually handle. A short-circuiting middleware (like
 * `requireTenantContext`, which 400s instead of calling `next()`) mounted
 * ahead of a router it doesn't belong to can intercept that router's
 * requests before they're ever dispatched -- see app.ts's own comment above
 * its mount list for the full writeup. This file imports the REAL `app`
 * (not a synthetic reconstruction) and drives real HTTP requests at it via
 * supertest, so a regression in mount order (or in requireTenantContext
 * scoping generally) fails a test here even if every router's own
 * standalone-app test still passes.
 *
 * Getting a real, signed-in identity into these requests is the hard part:
 * app.ts wires the REAL `supabaseAuthMiddleware`
 * (src/middlewares/supabaseAuth.ts), which verifies a bearer token against
 * Supabase's own remote JWKS -- there is no test-double seam here to attach
 * `req.supabaseUser` directly (that seam is exactly what
 * createAuthenticatedTestApp uses, and exactly what would defeat the point
 * of this file). Instead, `createRealTestUser` below drives actual user
 * creation + password sign-in against the local disposable Supabase
 * instance's own GoTrue auth server (the same instance TEST_DATABASE_URL
 * points at) to mint a real, JWKS-verifiable access token -- the same
 * credential-issuing path a real mobile/dashboard client goes through in
 * production. `supabaseAuthMiddleware` needs SUPABASE_URL/
 * SUPABASE_SERVICE_ROLE_KEY to even load (it reads them at module scope) --
 * both those and TEST_DATABASE_URL are asserted present before this
 * describe block runs at all (see `canRun` below); when any is missing the
 * whole block -- including the dynamic `import("../app")` that would
 * otherwise throw at load time -- is skipped, so a local/CI run without the
 * full Supabase env stays green, matching every other DB-gated suite in
 * this repo.
 *
 * `app` itself, and every route module app.ts statically imports, is loaded
 * lazily inside `before()` -- not as a top-level `import` -- for the same
 * reason cross-tenant.test.ts's own combinedRouter import is lazy: a
 * top-of-file static import evaluates before any runtime skip logic runs
 * (ESM modules are evaluated eagerly), so it would crash the ENTIRE
 * `node --test` run (every test FILE in this package is passed to a single
 * node process -- see scripts/run-tests.mjs) the moment SUPABASE_URL is
 * unset, even for a run that never intends to exercise this file at all.
 */
const dbUrl = requireTestDatabaseUrl();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(dbUrl && supabaseUrl && supabaseServiceRoleKey);
closeDatabasePoolAfterTests();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

/**
 * Creates a brand-new Supabase auth user (randomized email -- see the
 * module doc comment on why a fixed email would collide across repeated
 * runs against this same persistent local database) and signs in as them,
 * returning a real GoTrue-issued access token. Two admin-key-authenticated
 * calls: `auth.admin.createUser` (bypasses email confirmation via
 * `email_confirm: true`, so no inbox/webhook is needed) followed by
 * `auth.signInWithPassword` (the real password-grant token exchange) --
 * confirmed independently against this repo's local disposable Supabase
 * instance that the resulting token verifies successfully against
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` via `jose.jwtVerify`, the
 * exact check `supabaseAuthMiddleware` performs.
 */
async function createRealTestUser(): Promise<{
  userId: string;
  email: string;
  accessToken: string;
}> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(supabaseUrl!, supabaseServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `app-test-${randomUUID()}@app-test.example.com`;
  const password = `Test-${randomUUID()}!Aa1`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createRealTestUser: failed to create user: ${createErr?.message}`);
  }

  const { data: signedIn, error: signInErr } = await admin.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !signedIn.session) {
    throw new Error(`createRealTestUser: failed to sign in: ${signInErr?.message}`);
  }

  return { userId: created.user.id, email, accessToken: signedIn.session.access_token };
}

/** Deletes a real Supabase auth user created by createRealTestUser, so repeated local runs don't leak `auth.users` rows. */
async function deleteRealTestUser(userId: string): Promise<void> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(supabaseUrl!, supabaseServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.auth.admin.deleteUser(userId).catch(() => {
    // Best-effort cleanup only -- a failed delete here must never fail the suite.
  });
}

describe("app.ts: real mount stack (Task 12.5 regression)", { skip: !canRun }, () => {
  const createdUserIds: string[] = [];

  before(async () => {
    // Point @workspace/db at the test database BEFORE anything (app.ts's
    // route modules) statically imports it -- mirrors useDatabaseFixture's
    // own before() hook.
    process.env.DATABASE_URL = dbUrl;
    app = (await import("../app")).default;
  });

  after(async () => {
    for (const userId of createdUserIds) {
      await deleteRealTestUser(userId);
    }
  });

  test("brand-new user can POST /api/facilities through the real app after the wizard bootstrap provisions their org (TEN-012)", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    // TEN-012: POST /facilities no longer creates the org. The real client
    // flow bootstraps it at GET /wizard/progress (ensureOwnerOrg), which the
    // real app mounts behind requireSignedIn only (no X-Facility-Id needed).
    // Drive that first so the subsequent POST has an org to attach to — this
    // also still exercises the mount-ordering regression the file guards
    // against (an earlier requireTenantContext-gated mount must not intercept
    // POST /facilities and 400).
    const bootstrapRes = await request(app)
      .get("/api/wizard/progress")
      .set("Authorization", `Bearer ${user.accessToken}`);
    strictEqual(
      bootstrapRes.status,
      200,
      `wizard bootstrap must succeed: got ${bootstrapRes.status}: ${JSON.stringify(bootstrapRes.body)}`,
    );

    const res = await request(app)
      .post("/api/facilities")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ farmName: "Regression Test Farm", timezone: "UTC", units: "metric", currency: "USD" });

    strictEqual(
      res.status,
      201,
      `expected 201, got ${res.status}: ${JSON.stringify(res.body)} -- before the reorder, this request could be intercepted by an earlier requireTenantContext-gated mount (e.g. alertsRouter's) and 400`,
    );
    ok(res.body.facilityId, "response must include the new facilityId");
  });

  test("same brand-new user can GET /api/facilities/me and gets 200 with null, not 400", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const res = await request(app)
      .get("/api/facilities/me")
      .set("Authorization", `Bearer ${user.accessToken}`);

    strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    strictEqual(res.body, null);
  });

  test("existing user WITH a resolved facility: GET /api/alerts with a valid X-Facility-Id still gets normal (200) behavior through the real app", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    const { facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: user.userId, email: user.email },
      { farmName: "Alerts Regression Farm" },
    );

    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .set("X-Facility-Id", String(facilityId));

    strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    ok(Array.isArray(res.body), "GET /api/alerts must return an array");
  });

  test("same existing user, same route, NO X-Facility-Id header: still correctly gets 400 (the gate itself still works, just correctly scoped now)", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: user.userId, email: user.email },
      { farmName: "Alerts Regression Farm 2" },
    );

    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${user.accessToken}`);

    strictEqual(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test("unauthenticated request (no bearer token) still correctly gets 401 through the real app", async () => {
    const res = await request(app).get("/api/facilities/me");
    strictEqual(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test("brand-new user hitting a tier-4 (self-gated requireTenantContext+requireRole) route with no X-Facility-Id still correctly 400s, not 500/leak", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const res = await request(app)
      .get("/api/inventory")
      .set("Authorization", `Bearer ${user.accessToken}`);

    strictEqual(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test("TEN-014: GET /api/sensor-readings with no X-Facility-Id 400s through the real app (hotfix regression -- previously tier-1/ungated, so this returned 200 with a global cross-tenant dump)", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const res = await request(app)
      .get("/api/sensor-readings")
      .set("Authorization", `Bearer ${user.accessToken}`);

    strictEqual(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test("signed-in user with NO X-Facility-Id hitting media.ts's route in the catch-all router (routes/index.ts) is NOT intercepted by an earlier tenant gate -- media.ts's own (gate-less) handler is reached", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    // No file attached and no X-Facility-Id header. If an earlier
    // requireTenantContext-gated mount intercepted this request (the app.ts
    // ordering bug this test locks in), it would 400 with "Missing or
    // invalid X-Facility-Id" before ever reaching media.ts. Reaching
    // media.ts's own handler instead 400s with "No file provided" -- proving
    // the catch-all router (which media.ts is bundled into via
    // routes/index.ts) is mounted somewhere no earlier gate can intercept it.
    const res = await request(app)
      .post("/api/media/upload")
      .set("Authorization", `Bearer ${user.accessToken}`);

    strictEqual(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    strictEqual(
      res.body.error,
      "No file provided",
      `expected media.ts's own handler to be reached, not an earlier tenant gate: ${JSON.stringify(res.body)}`,
    );
  });

  // TEN-012 Task 6: backend email-verification gate (requireVerifiedEmail),
  // mounted as a standalone `/api` middleware after the PUBLIC routers and
  // before every requireSignedIn-gated tier. Two things must hold through the
  // real app stack: a VERIFIED user passes the gate and reaches a protected
  // route, and the PUBLIC accept route (mounted above the gate) is never
  // intercepted by it.
  test("verified user (email_confirm:true) passes requireVerifiedEmail and reaches GET /api/wizard/progress (200) through the real app", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const res = await request(app)
      .get("/api/wizard/progress")
      .set("Authorization", `Bearer ${user.accessToken}`);

    // createRealTestUser uses email_confirm:true, so the JWT carries
    // user_metadata.email_verified === true (verified empirically against this
    // repo's disposable GoTrue). The verification gate must let it through to
    // the tier-1 wizard bootstrap. A 403 { code: "EMAIL_UNVERIFIED" } here
    // would mean the gate is wrongly blocking a verified user.
    strictEqual(
      res.status,
      200,
      `verified user must pass the email-verification gate: got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  });

  test("an UNVERIFIED session cannot be minted at all: GoTrue refuses signInWithPassword for an email_confirm:false user (this IS the primary control that makes requireVerifiedEmail defense-in-depth)", async () => {
    // The brief asks whether an unverified token can be minted against the
    // disposable GoTrue to assert a 403 on a protected route. It CANNOT: with
    // email confirmation required, GoTrue never issues a session for an
    // unconfirmed address — signInWithPassword fails with "Email not
    // confirmed" and no access token is produced. That is precisely the
    // PRIMARY control; requireVerifiedEmail is the secondary/defense-in-depth
    // layer (unit-tested directly with a stubbed emailVerified:false claim in
    // tests/middlewares/requireVerifiedEmail.test.ts, since no real
    // unverified token exists to drive the full stack with). We assert the
    // refusal here so this documented fact is itself covered.
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(supabaseUrl!, supabaseServiceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `app-test-unconfirmed-${randomUUID()}@app-test.example.com`;
    const password = `Test-${randomUUID()}!Aa1`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });
    if (createErr || !created.user) {
      throw new Error(`could not create unconfirmed user: ${createErr?.message}`);
    }
    createdUserIds.push(created.user.id);

    const { data: signedIn, error: signInErr } = await admin.auth.signInWithPassword({
      email,
      password,
    });
    strictEqual(signedIn.session, null, "GoTrue must NOT issue a session for an unconfirmed user");
    ok(signInErr, "signInWithPassword must error for an unconfirmed user (primary confirm-email control)");
  });

  // TEN-010 Task 9: invitations.ts/members.ts are tier-4 self-gating routers,
  // mounted LAST so their self-gate (router.use(requireTenantContext,
  // requireRole("owner","admin")) inside the router file itself) can't
  // intercept OTHER routers' valid non-owner/admin users. invitationsAccept.ts
  // is deliberately PUBLIC (no
  // requireSignedIn at all -- the invitee has no session yet). These three
  // cases drive the REAL app stack to prove both halves actually hold: the
  // self-mounted requireRole gate rejects a non-owner/admin caller, an
  // owner/admin caller succeeds, and the accept endpoint is reachable with NO
  // Authorization header whatsoever (the regression guard for the plan
  // correction that moved it out of the requireSignedIn group).
  test("owner JWT with X-Facility-Id: POST /api/invitations succeeds (201) through the real app -- self-mounted requireTenantContext+requireRole gate lets owner/admin through", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    const { facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: user.userId, email: user.email },
      { farmName: "Invitations Regression Farm (owner)", memberRole: "owner" },
    );

    const previousTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "record"; // avoid a real network call to Resend

    try {
      const res = await request(app)
        .post("/api/invitations")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .set("X-Facility-Id", String(facilityId))
        .send({ email: `invitee-${randomUUID()}@app-test.example.com`, role: "technician" });

      strictEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    } finally {
      if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
      else process.env.EMAIL_TRANSPORT = previousTransport;
    }
  });

  test("technician JWT with X-Facility-Id: POST /api/invitations is rejected 403 ROLE_FORBIDDEN through the real app -- proves the self-mounted requireRole gate works through the real app stack, not just invitations.ts's own standalone-app test", async () => {
    const user = await createRealTestUser();
    createdUserIds.push(user.userId);

    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
      "@workspace/db"
    );
    const { facilityId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: user.userId, email: user.email },
      { farmName: "Invitations Regression Farm (technician)", memberRole: "technician" },
    );

    const res = await request(app)
      .post("/api/invitations")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .set("X-Facility-Id", String(facilityId))
      .send({ email: `invitee-${randomUUID()}@app-test.example.com`, role: "technician" });

    strictEqual(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    strictEqual(res.body.code, "ROLE_FORBIDDEN", `expected code ROLE_FORBIDDEN: ${JSON.stringify(res.body)}`);
  });

  test("POST /api/invitations/accept with NO Authorization header at all is NOT 401 -- proves it's mounted PUBLIC, not behind requireSignedIn (the plan-correction regression guard: if this were mounted behind requireSignedIn like the plan brief originally specified, a brand-new invitee with no account yet could never reach it, and this would 401 instead of 400)", async () => {
    const res = await request(app)
      .post("/api/invitations/accept")
      .send({ token: "bogus-invalid-token", password: "irrelevant-but-8-chars" });

    strictEqual(
      res.status,
      400,
      `expected 400 (invalid token, reached the real handler), got ${res.status}: ${JSON.stringify(res.body)} -- a 401 here would mean requireSignedIn is (wrongly) gating this route`,
    );
  });

  // Task 11 remediation: metrics.ts/inventory.ts/shipments.ts/accounting.ts
  // (accountingRouter, not the public OAuth-callback router) previously had
  // ZERO server-side role enforcement -- any signed-in tenant member of any
  // role, including technician, could reach them, and inventory/shipments
  // also exposed unguarded POST/PATCH/DELETE. Each now self-gates via
  // router.use(requireTenantContext, requireRole("owner","admin")), the same
  // pattern as invitations.ts/members.ts above, and is mounted in app.ts's
  // tier 4 (after every router a technician is allowed to reach). These four
  // cases drive the REAL app stack -- not a standalone per-router test app --
  // so a technician is rejected and an owner succeeds through the actual
  // mount order, not just each router's own isolated test.
  for (const route of [
    { name: "metrics", path: "/api/metrics/availability" },
    { name: "inventory", path: "/api/inventory" },
    { name: "shipments", path: "/api/shipments" },
    { name: "accounting", path: "/api/accounting/status" },
  ] as const) {
    test(`technician JWT with X-Facility-Id: GET ${route.path} is rejected 403 ROLE_FORBIDDEN through the real app`, async () => {
      const user = await createRealTestUser();
      createdUserIds.push(user.userId);

      const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
        "@workspace/db"
      );
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: user.userId, email: user.email },
        { farmName: `${route.name} Regression Farm (technician)`, memberRole: "technician" },
      );

      const res = await request(app)
        .get(route.path)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .set("X-Facility-Id", String(facilityId));

      strictEqual(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
      strictEqual(res.body.code, "ROLE_FORBIDDEN", `expected code ROLE_FORBIDDEN: ${JSON.stringify(res.body)}`);
    });

    test(`owner JWT with X-Facility-Id: GET ${route.path} succeeds (200) through the real app`, async () => {
      const user = await createRealTestUser();
      createdUserIds.push(user.userId);

      const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import(
        "@workspace/db"
      );
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: user.userId, email: user.email },
        { farmName: `${route.name} Regression Farm (owner)`, memberRole: "owner" },
      );

      const res = await request(app)
        .get(route.path)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .set("X-Facility-Id", String(facilityId));

      strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
  }
});
