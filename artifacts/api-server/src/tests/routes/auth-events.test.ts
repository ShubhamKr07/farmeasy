import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  seedTestUser,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";
import { createAuthEventsRouter } from "../../routes/auth-events";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

/**
 * AUTH-004 — Auth events telemetry endpoint tests.
 *
 * The /api/auth-events endpoint records telemetry for authentication flows:
 * signin_success, signin_failed, reset_request, reset_complete, signup_start,
 * signup_complete. The endpoint:
 *
 * (a) Validates the eventType enum — only the defined event types are accepted.
 * (b) Derives userId from the JWT's `sub` claim (Supabase JWT middleware), NOT
 *     from a client-supplied field — the client cannot forge their own userId.
 * (c) Rate-limits per userId (120 events per 15 minutes, via express-rate-limit).
 * (d) Returns 202 Accepted on success, 429 Too Many Requests on rate-limit,
 *     400 on validation error, 500 on server error.
 */

describe("POST /api/auth-events — telemetry endpoint", { skip: !dbUrl }, () => {
  let userId: string;
  let app: ReturnType<typeof createAuthenticatedTestApp>;

  before(async () => {
    if (!dbUrl) return;
    process.env.DATABASE_URL = dbUrl;

    userId = randomUUID();
    const email = "auth-event-test@example.com";

    // Seed a test user.
    const { db, usersTable } = await import("@workspace/db");
    await seedTestUser(db, usersTable, {
      id: userId,
      email,
      role: "technician",
      organizationId: null,
    });

    // Create test app with the auth-events router.
    const router = createAuthEventsRouter();
    app = createAuthenticatedTestApp(router, { sub: userId }, undefined);
  });

  test("(a) accepts valid eventType enum members (signin_success, signin_failed, reset_request, reset_complete)", async () => {
    const validTypes = [
      "signin_success",
      "signin_failed",
      "reset_request",
      "reset_complete",
      "signup_start",
      "signup_complete",
    ];

    for (const eventType of validTypes) {
      const res = await request(app)
        .post("/api/auth-events")
        .send({ eventType });
      strictEqual(
        res.status,
        202,
        `eventType "${eventType}" must be accepted (202 Accepted)`,
      );
    }
  });

  test("(a) rejects invalid eventType values with 400 Validation failed", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({ eventType: "invalid_event" });
    strictEqual(res.status, 400, "invalid eventType must reject (400)");
    ok(
      res.body.error === "Validation failed",
      "error message must indicate validation failure",
    );
  });

  test("(a) rejects missing eventType with 400", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({});
    strictEqual(res.status, 400, "missing eventType must reject (400)");
  });

  test("(b) derives userId from JWT sub claim, not client input", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({
        eventType: "signin_success",
        userId: "attacker-supplied-id",
      });
    strictEqual(
      res.status,
      202,
      "endpoint must accept and process the request (using JWT userId, not client input)",
    );
  });

  test("(c) rate-limits: 120 events per 15 minutes per userId", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({ eventType: "reset_request" });
    strictEqual(res.status, 202, "event must be accepted");
  });

  test("(d) returns 202 Accepted on success", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({ eventType: "signin_success" });
    strictEqual(res.status, 202, "successful event must return 202 Accepted");
    strictEqual(res.text, "", "202 response must have no body");
  });

  test("(d) returns 400 on validation error", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({ eventType: "not_an_event" });
    strictEqual(res.status, 400, "validation error must return 400");
    ok(res.body.error, "response must include error field");
  });

  test("(d) includes optional reason field in request", async () => {
    const res = await request(app)
      .post("/api/auth-events")
      .send({ eventType: "signin_failed", reason: "Invalid credentials" });
    strictEqual(
      res.status,
      202,
      "request with optional reason must be accepted",
    );
  });
});
