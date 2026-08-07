// artifacts/api-server/src/tests/middlewares/requireVerifiedEmail.test.ts
import { describe, test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import type { Request, Response } from "express";
import { requireVerifiedEmail } from "../../middlewares/requireVerifiedEmail";

/**
 * Unit test for the TEN-012 Task 6 backend email-verification gate.
 *
 * requireVerifiedEmail reads its signal via getAuth(req), which sources
 * `req.supabaseUser.emailVerified` (populated by supabaseAuthMiddleware from
 * the verified JWT). We stub `req.supabaseUser` directly here — no token,
 * JWKS, or DB needed — exactly the seam createAuthenticatedTestApp uses to
 * inject identity, so this file needs none of the Supabase env the real
 * app.test.ts requires. Three cases lock in the tri-state decision:
 * explicit false → 403; explicit true → next(); ABSENT (undefined) → next()
 * (fail-open on absence, primary confirm-email control still holds).
 */

// Minimal Response double: records the status + json body, and asserts next()
// is NOT called on the block path.
function makeReqRes(emailVerified: boolean | undefined) {
  const req = {
    supabaseUser: { sub: "user-123", email: "u@example.com", emailVerified },
  } as unknown as Request;

  const state: { statusCode?: number; body?: unknown; nextCalled: boolean } = {
    nextCalled: false,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  const next = () => {
    state.nextCalled = true;
  };
  return { req, res, next, state };
}

describe("requireVerifiedEmail (TEN-012 Task 6)", () => {
  test("emailVerified === false → 403 { code: 'EMAIL_UNVERIFIED' }, next() NOT called", () => {
    const { req, res, next, state } = makeReqRes(false);
    requireVerifiedEmail(req, res, next);
    strictEqual(state.statusCode, 403);
    deepStrictEqual(state.body, { code: "EMAIL_UNVERIFIED" });
    strictEqual(state.nextCalled, false, "must NOT call next() when explicitly unverified");
  });

  test("emailVerified === true → next() called, no status set", () => {
    const { req, res, next, state } = makeReqRes(true);
    requireVerifiedEmail(req, res, next);
    strictEqual(state.nextCalled, true, "verified user must pass through");
    strictEqual(state.statusCode, undefined, "no response should be sent");
  });

  test("emailVerified undefined (claim ABSENT) → next() called, NOT blocked (fail-open on absence)", () => {
    const { req, res, next, state } = makeReqRes(undefined);
    requireVerifiedEmail(req, res, next);
    strictEqual(state.nextCalled, true, "absent claim must fall through to primary control, not 403");
    strictEqual(state.statusCode, undefined, "no response should be sent on absent claim");
  });

  test("no supabaseUser at all (unauthenticated reaching the gate) → next() (getAuth yields undefined)", () => {
    const req = {} as unknown as Request;
    const state = { statusCode: undefined as number | undefined, nextCalled: false };
    const res = {
      status(code: number) {
        state.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    requireVerifiedEmail(req, res, () => {
      state.nextCalled = true;
    });
    strictEqual(state.nextCalled, true);
    strictEqual(state.statusCode, undefined);
  });
});
