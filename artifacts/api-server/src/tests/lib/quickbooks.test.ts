import { describe, test, before, after } from "node:test";
import { strictEqual, rejects } from "node:assert";

/**
 * ACC-004: on a 401 from QuickBooks, attempt EXACTLY ONE silent refresh +
 * retry before surfacing the error to the caller (routes/metrics.ts, then
 * Accounting.tsx's expired-connection banner) -- capped at one to avoid
 * hammering QBO's rate limits on a truly-expired connection (PRD Risks:
 * "Reconnect loop... capped at one").
 *
 * `runWithOneRefreshRetry` is the pure policy extracted from
 * `callWithReactiveRefresh` specifically so this cap is testable without a
 * live QuickBooks connection or a database -- `apiCall`/`refresh` below are
 * plain fakes with call counters, not the real OAuthClient/DB plumbing
 * (which has no test double in this repo).
 *
 * `../../lib/accounting/quickbooks` imports `@workspace/db` at module scope,
 * which throws immediately if DATABASE_URL is unset (mirrors
 * accounting.test.ts's own QuickBooks-callback suite) -- `pg.Pool` itself
 * connects lazily, and neither function under test ever runs a query, so a
 * syntactically-valid dummy value is sufficient. Imported lazily inside
 * before() so this file doesn't crash the whole `node --test` run when
 * DATABASE_URL happens to be unset for an otherwise DB-less local run.
 */
let runWithOneRefreshRetry: typeof import("../../lib/accounting/quickbooks").runWithOneRefreshRetry;
let isUnauthorizedError: typeof import("../../lib/accounting/quickbooks").isUnauthorizedError;
let savedDatabaseUrl: string | undefined;

before(async () => {
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (process.env.DATABASE_URL === undefined) {
    process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  }
  ({ runWithOneRefreshRetry, isUnauthorizedError } = await import("../../lib/accounting/quickbooks"));
});

after(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe("runWithOneRefreshRetry (ACC-004)", () => {
  function unauthorizedError(): Error & { code: string } {
    return Object.assign(new Error("HTTP Error"), { code: "401" });
  }

  test("apiCall succeeds on the first try: refresh is never called", async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    const result = await runWithOneRefreshRetry(
      async () => {
        apiCalls++;
        return "ok";
      },
      async () => {
        refreshCalls++;
        return true;
      },
    );
    strictEqual(result, "ok");
    strictEqual(apiCalls, 1);
    strictEqual(refreshCalls, 0);
  });

  test("apiCall throws a non-401 error: propagates immediately, refresh never called", async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    const notAuthError = Object.assign(new Error("Rate limit exceeded"), { code: "429" });
    await rejects(
      () =>
        runWithOneRefreshRetry(
          async () => {
            apiCalls++;
            throw notAuthError;
          },
          async () => {
            refreshCalls++;
            return true;
          },
        ),
      (err: unknown) => err === notAuthError,
    );
    strictEqual(apiCalls, 1);
    strictEqual(refreshCalls, 0);
  });

  test("recoverable: 401 then refresh succeeds then retry succeeds -- caller never sees an error", async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    const result = await runWithOneRefreshRetry(
      async () => {
        apiCalls++;
        if (apiCalls === 1) throw unauthorizedError();
        return "recovered";
      },
      async () => {
        refreshCalls++;
        return true;
      },
    );
    strictEqual(result, "recovered", "the retry's success must be returned to the caller");
    strictEqual(apiCalls, 2, "exactly one retry (initial call + one retry)");
    strictEqual(refreshCalls, 1, "exactly one refresh attempt, not zero and not more than one");
  });

  test("unrecoverable (refresh itself fails): the ORIGINAL 401 surfaces, no second apiCall attempt", async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    const originalError = unauthorizedError();
    await rejects(
      () =>
        runWithOneRefreshRetry(
          async () => {
            apiCalls++;
            throw originalError;
          },
          async () => {
            refreshCalls++;
            return false; // refresh itself failed (e.g. refresh_token revoked)
          },
        ),
      (err: unknown) => err === originalError,
    );
    strictEqual(apiCalls, 1, "no retry when the refresh itself failed");
    strictEqual(refreshCalls, 1, "exactly one refresh attempt, not zero and not more than one");
  });

  test("unrecoverable (refresh succeeds but QuickBooks still rejects): retry's own 401 is final, refresh is not attempted again", async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    await rejects(
      () =>
        runWithOneRefreshRetry(
          async () => {
            apiCalls++;
            throw unauthorizedError(); // 401 both times
          },
          async () => {
            refreshCalls++;
            return true;
          },
        ),
      (err: unknown) => (err as { code?: string }).code === "401",
    );
    strictEqual(apiCalls, 2, "initial call + exactly one retry, never more");
    strictEqual(refreshCalls, 1, "the cap: exactly one refresh attempt even though the retry ALSO 401s");
  });
});

describe("isUnauthorizedError", () => {
  test("true for an error with code '401' (intuit-oauth's OAuthError shape)", () => {
    strictEqual(isUnauthorizedError(Object.assign(new Error("x"), { code: "401" })), true);
  });

  test("false for other HTTP error codes (429, 500, 400)", () => {
    strictEqual(isUnauthorizedError(Object.assign(new Error("x"), { code: "429" })), false);
    strictEqual(isUnauthorizedError(Object.assign(new Error("x"), { code: "500" })), false);
    strictEqual(isUnauthorizedError(Object.assign(new Error("x"), { code: "400" })), false);
  });

  test("false for a plain Error with no code, null, or a non-object", () => {
    strictEqual(isUnauthorizedError(new Error("plain")), false);
    strictEqual(isUnauthorizedError(null), false);
    strictEqual(isUnauthorizedError("401"), false);
    strictEqual(isUnauthorizedError(undefined), false);
  });
});
