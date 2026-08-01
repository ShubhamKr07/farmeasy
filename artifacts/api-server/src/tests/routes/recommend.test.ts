import { describe, test, before, after } from "node:test";
import {
  strictEqual,
  notStrictEqual,
  throws,
  ok,
} from "node:assert";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from "express";
import request from "supertest";
import http from "node:http";
import {
  parseTrustProxyHops,
  resolveTrustProxy,
} from "../../lib/trustProxy";
import { DEFAULT_TEST_USER } from "../helpers/testApp";

/**
 * Release 1 Task 9, Steps 4-6 (Sub-task B):
 *   - Step 4: global express.json() body limit reduced 20mb → 1mb (asserted
 *     indirectly — an oversized JSON body is now rejected with 413 by the
 *     1mb limiter instead of being parsed; covered by the rate-limit suites
 *     which send small bodies).
 *   - Step 5: TRUST_PROXY_HOPS fail-closed in production; Express `trust
 *     proxy` set to it; two INDEPENDENT recommendation limiters (20/15min by
 *     userId, 60/15min by ipKeyGenerator(req.ip)), never a composite key.
 *   - Step 6: question trimmed + length-capped (2,000) before any dashboard
 *     work; upstream fetch bounded by AbortSignal.timeout(10_000).
 *
 * None of these scenarios need a real database or a live recommender service:
 *   - The TRUST_PROXY_HOPS and trust-proxy-spoofing checks are pure / use a
 *     trivial express app (no recommend route, no DB).
 *   - The rate-limit + length-cap suites point RECOMMENDER_URL at nothing
 *     (unset) so the handler returns 503 from its "not configured" branch
 *     WITHOUT ever calling fetch or computeDashboardSnapshot — the limiters
 *     increment on the way in regardless, which is exactly what we want to
 *     exercise. (Validation runs before the RECOMMENDER_URL check, so the
 *     2,001-char rejection returns 400 even earlier.)
 *   - The fetch-timeout suite spins up a local http server that accepts the
 *     connection but never responds, with a short RECOMMENDER_FETCH_TIMEOUT_MS
 *     override so the test doesn't wait a real 10s.
 *
 * Importing routes/recommend.ts still pulls in @workspace/db and
 * supabaseAuth.ts, both of which read env vars at module load — so a
 * file-level before() seeds syntactically-valid dummies (mirrors
 * accounting.test.ts) and after() restores them. No real connection is ever
 * opened: pg.Pool connects lazily and no query runs in these paths.
 */

// --- file-level env seeding so the dynamic import of recommend.ts works ---

const ENV_DEFAULTS = {
  DATABASE_URL: "postgres://dummy:dummy@localhost:5432/dummy",
  SUPABASE_URL: "https://dummy.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role-key",
} as const;

// Keys recommend.ts transitively needs at module load. Seeded only when
// unset so a real CI environment isn't clobbered; restored verbatim in after.
const MODULE_LOAD_ENV_KEYS = Object.keys(ENV_DEFAULTS) as (keyof typeof ENV_DEFAULTS)[];
const savedModuleLoadEnv: Record<string, string | undefined> = {};

before(() => {
  for (const k of MODULE_LOAD_ENV_KEYS) {
    savedModuleLoadEnv[k] = process.env[k];
    if (process.env[k] === undefined) process.env[k] = ENV_DEFAULTS[k];
  }
});

after(() => {
  for (const k of MODULE_LOAD_ENV_KEYS) {
    if (savedModuleLoadEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedModuleLoadEnv[k];
  }
});

/**
 * Snapshot/restore a set of env keys around a describe scope, and CLEAR them
 * in `before` so each suite starts from a known-empty state. Clearing (not
 * just save/restore) is what keeps the rate-limit and length-cap suites
 * deterministic: they assert the 503 "recommender not configured" branch and
 * must never inherit a leftover RECOMMENDER_URL from another suite, earlier
 * process state, or the shell. Suites that NEED a value set it in their own
 * `before`/test body after this clears.
 */
function scopedEnv(keys: readonly string[]) {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  return saved;
}

// =============================================================================
// Step 5 (part 1): TRUST_PROXY_HOPS production fail-closed + parsing
// =============================================================================

describe("TRUST_PROXY_HOPS fail-closed & parsing (Task 9 Step 5)", () => {
  test("resolveTrustProxy throws when TRUST_PROXY_HOPS is unset in production", () => {
    // Empty/unset under NODE_ENV=production must fail startup (throw) rather
    // than silently trust no/wrong hops. resolveTrustProxy is what app.ts
    // calls at module load (server boot).
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production" }),
      /TRUST_PROXY_HOPS/,
      "unset TRUST_PROXY_HOPS in production should throw at startup",
    );
  });

  test("resolveTrustProxy throws when TRUST_PROXY_HOPS is empty in production", () => {
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "   " }),
      /TRUST_PROXY_HOPS/,
      "whitespace-only TRUST_PROXY_HOPS in production should throw",
    );
  });

  test("resolveTrustProxy throws for a non-positive-integer value in production", () => {
    // "0" is present-but-malformed → parseTrustProxyHops throws (the
    // fail-closed path isn't just "unset", it's also "garbage").
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "0" }),
      /positive integer/,
    );
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "abc" }),
      /positive integer/,
    );
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "1.5" }),
      /positive integer/,
    );
    throws(
      () => resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "-1" }),
      /positive integer/,
    );
  });

  test("resolveTrustProxy returns the parsed hop count when set in production", () => {
    strictEqual(
      resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "1" }),
      1,
    );
    strictEqual(
      resolveTrustProxy({ NODE_ENV: "production", TRUST_PROXY_HOPS: "2" }),
      2,
    );
  });

  test("resolveTrustProxy allows unset TRUST_PROXY_HOPS outside production", () => {
    // Non-production: var optional → undefined (app.ts skips app.set, leaving
    // Express's default "trust no proxy" so loopback dev/test traffic is
    // unaffected).
    strictEqual(resolveTrustProxy({ NODE_ENV: "test" }), undefined);
    strictEqual(resolveTrustProxy({ NODE_ENV: "development" }), undefined);
  });

  test("resolveTrustProxy honors an explicit hop count outside production when set", () => {
    strictEqual(
      resolveTrustProxy({ NODE_ENV: "development", TRUST_PROXY_HOPS: "1" }),
      1,
    );
  });

  test("parseTrustProxyHops: unset/empty → undefined; valid → number", () => {
    strictEqual(parseTrustProxyHops(undefined), undefined);
    strictEqual(parseTrustProxyHops(""), undefined);
    strictEqual(parseTrustProxyHops("  "), undefined);
    strictEqual(parseTrustProxyHops("1"), 1);
    strictEqual(parseTrustProxyHops("007"), 7);
    strictEqual(parseTrustProxyHops("  2  "), 2);
  });

  test("parseTrustProxyHops rejects non-integer / non-positive strings", () => {
    for (const bad of ["0", "abc", "1.5", "-1", "1e0", "0x1", "+1", "1.0"]) {
      throws(
        () => parseTrustProxyHops(bad),
        /positive integer/,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });
});

// =============================================================================
// Step 5 (part 2): trust proxy makes spoofed XFF left-most entries harmless
// =============================================================================

/**
 * Minimal express app mirroring how app.ts sets `trust proxy`. The endpoint
 * echoes req.ip so we can assert which address Express resolved the request
 * to — the rate limiter keys off this exact value.
 */
function trustProxyApp(hops: number | boolean): Express {
  const app = express();
  app.set("trust proxy", hops);
  app.get("/ip", (req: Request, res: Response) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe("trust proxy: spoofed X-Forwarded-For left-most entry ignored (Task 9 Step 5)", () => {
  test("with trust proxy = 1, a forged left-most XFF entry does NOT become req.ip", async () => {
    // Real single-hop path simulation: the client forges "9.9.9.9" as the
    // left-most XFF entry; Render's edge appends the client's REAL TCP IP
    // on the right. With trust proxy = 1 Express trusts exactly the one
    // edge hop, so req.ip resolves to the rightmost (real) entry — the
    // forged value on the left is discarded.
    const app = trustProxyApp(1);
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "9.9.9.9, 127.0.0.1");

    strictEqual(res.status, 200);
    notStrictEqual(
      res.body.ip,
      "9.9.9.9",
      "forged left-most XFF entry must not become req.ip when trust proxy is correctly bounded",
    );
    // And it resolves to the trusted (rightmost) entry, not the forged one.
    strictEqual(res.body.ip, "127.0.0.1");
  });

  test("contrast: with trust proxy = true (unbounded), the forged entry IS trusted", async () => {
    // This is the footgun TRUST_PROXY_HOPS prevents: `trust proxy = true`
    // trusts every XFF hop, so the attacker-controlled left-most entry wins
    // and an IP-based rate limiter is trivially bypassable.
    const app = trustProxyApp(true);
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "9.9.9.9, 127.0.0.1");

    strictEqual(res.status, 200);
    strictEqual(
      res.body.ip,
      "9.9.9.9",
      "trust proxy = true trusts the spoofed left-most entry (the danger we avoid)",
    );
  });

  test("contrast: with trust proxy = 2 (too many hops), the forged entry IS trusted", async () => {
    // Over-trusting the hop count reaches past the single real edge hop into
    // attacker-controlled XFF territory — same spoof as trust=true.
    const app = trustProxyApp(2);
    const res = await request(app)
      .get("/ip")
      .set("X-Forwarded-For", "9.9.9.9, 127.0.0.1");

    strictEqual(res.status, 200);
    strictEqual(
      res.body.ip,
      "9.9.9.9",
      "over-counted trust proxy trusts the spoofed entry (why the count must be exact)",
    );
  });
});

// =============================================================================
// Shared recommend-route test harness
// =============================================================================

/**
 * Build a test app for the recommend route. `createRecommendRouter()` is
 * called by the caller (fresh per suite) so each suite gets isolated
 * process-local rate-limit stores — without that, one suite's exhaustion
 * would bleed into the next.
 *
 * The auth double reads the authenticated user id from the
 * `x-test-user-sub` request header (defaulting to the harness default) so a
 * single app can serve MANY distinct authenticated users sharing one source
 * IP (all supertest requests come from loopback) — the exact scenario the
 * "two independent limiters, not a composite key" test needs.
 *
 * trust proxy is set to 1 (mirroring production's TRUST_PROXY_HOPS) so req.ip
 * is well-defined and matches how the IP limiter behaves in prod.
 */
function createRecommendTestApp(router: Router): Express {
  const app = express();
  app.use(express.json());
  app.set("trust proxy", 1);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sub = (req.get("x-test-user-sub") || DEFAULT_TEST_USER.sub).trim();
    req.supabaseUser = { sub, user_role: DEFAULT_TEST_USER.user_role };
    // Production mounts pinoHttp which sets req.log; the harness stubs it so
    // the fetch-timeout catch block's req.log.error(...) doesn't crash with
    // "Cannot read properties of undefined". (Other route suites only log on
    // error paths their happy-path tests never hit; this suite deliberately
    // drives the error path.)
    req.log = NOOP_LOGGER;
    next();
  });
  app.use("/api", router);
  return app;
}

/** A short, non-ops question (so computeDashboardSnapshot is never reached → no DB). */
const VALID_QUESTION = "What lettuce variety grows fastest in a vertical channel?";

/**
 * No-op logger injected as `req.log` in the test harness so the recommend
 * handler's error-path `req.log.error(...)` calls don't crash. Cast to pino's
 * Logger type (what pino-http installs on req.log in production).
 */
const NOOP_LOGGER = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  fatal() {},
  trace() {},
  child() {
    return NOOP_LOGGER;
  },
} as unknown as import("pino").Logger;

// =============================================================================
// Step 6 (part 1): question length cap (2,000 chars; strictly greater rejected)
// =============================================================================

describe("recommend question length cap (Task 9 Step 6)", () => {
  // Validation runs before the RECOMMENDER_URL check, so a too-long question
  // returns 400 without ever reaching fetch — no recommender needed. A valid
  // (≤2,000) question reaches the "not configured" 503 branch, proving it
  // passed the cap.
  scopedEnv(["RECOMMENDER_URL", "RECOMMENDER_INTERNAL_KEY"]);

  test("2,001-character question is rejected (400)", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());
    const tooLong = "x".repeat(2001);

    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-length-1")
      .send({ question: tooLong });

    strictEqual(res.status, 400, "2001-char question must be rejected");
    ok(
      typeof res.body.error === "string" && /2000/.test(res.body.error),
      "error message should name the 2000-char cap",
    );
  });

  test("exactly 2,000-character question passes the cap (reaches the next branch)", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-length-2")
      .send({ question: "x".repeat(2000) });

    // Passed the length cap → next branch is the "recommender not configured"
    // 503 (RECOMMENDER_URL unset in this suite). NOT 400.
    strictEqual(res.status, 503, "2000-char question should pass validation");
  });

  test("question is trimmed before the cap is applied (whitespace-only → 400)", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-length-3")
      .send({ question: "      " });

    strictEqual(res.status, 400);
  });

  test("missing/non-string question → 400", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-length-4")
      .send({ question: 42 });

    strictEqual(res.status, 400);
  });
});

// =============================================================================
// Step 5 (part 3): per-USER rate limiter (20 req / 15 min) — 21st rejected
// =============================================================================

describe("recommend per-USER rate limit: 21st request in window rejected (Task 9 Step 5)", () => {
  // RECOMMENDER_URL unset → handler returns 503 from "not configured" WITHOUT
  // calling fetch. The limiter still increments on the way in (it counts
  // every request that reaches the route), so this exercises the budget.
  scopedEnv(["RECOMMENDER_URL", "RECOMMENDER_INTERNAL_KEY"]);

  test("first 20 requests pass, 21st is rejected with 429", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    // Requests 1..20 — all from the SAME authenticated user (same x-test-user-
    // sub), same source IP (loopback). Each passes both limiters and reaches
    // the 503 "not configured" branch.
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/recommend")
        .set("x-test-user-sub", "user-A")
        .send({ question: VALID_QUESTION });
      strictEqual(
        res.status,
        503,
        `request ${i + 1}/20 should reach the handler (503 = recommender not configured), not be rate-limited`,
      );
    }

    // 21st from the same user → exceeds the per-USER 20/15min budget → 429.
    const blocked = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-A")
      .send({ question: VALID_QUESTION });
    strictEqual(blocked.status, 429, "21st request in the window must be rejected");
  });

  test("a DIFFERENT user still has their own 20-request budget (not composite with user-A)", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    // Burn user-A's entire budget.
    for (let i = 0; i < 20; i++) {
      await request(app)
        .post("/api/recommend")
        .set("x-test-user-sub", "user-A2")
        .send({ question: VALID_QUESTION });
    }

    // user-B, sharing the same loopback IP as user-A2, still gets through —
    // the per-USER limiter keyed on userId, and per-IP budget (60) isn't
    // exhausted by 21 total requests. This is the independence guarantee.
    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-B2")
      .send({ question: VALID_QUESTION });
    strictEqual(res.status, 503, "a second distinct user behind the same IP must NOT inherit user-A's exhaustion");
  });
});

// =============================================================================
// Step 5 (part 4): per-IP rate limiter (60 req / 15 min), INDEPENDENT of per-user
// =============================================================================

describe("recommend per-IP rate limit is independent of per-USER (Task 9 Step 5)", () => {
  scopedEnv(["RECOMMENDER_URL", "RECOMMENDER_INTERNAL_KEY"]);

  test("many distinct users behind one IP each get 20, but the IP's aggregate 60 caps total", async () => {
    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    // 3 distinct users, 20 requests each = 60 total from the SAME loopback IP.
    // Every one of the 60 must pass: each user is under their own 20-budget
    // (independence), and the IP's 60-budget is exactly hit but not exceeded.
    const users = ["nat-user-1", "nat-user-2", "nat-user-3"];
    for (const user of users) {
      for (let i = 0; i < 20; i++) {
        const res = await request(app)
          .post("/api/recommend")
          .set("x-test-user-sub", user)
          .send({ question: VALID_QUESTION });
        strictEqual(
          res.status,
          503,
          `${user} request ${i + 1}/20 must pass (own 20-budget; IP total under 60) — got ${res.status}`,
        );
      }
    }

    // 61st from a FOURTH distinct user sharing the same IP: its own per-USER
    // budget is fresh (0 hits), so the per-USER limiter passes — but the per-
    // IP limiter has now seen 61 hits for this IP and blocks. This proves the
    // two limiters are independent (the 4th user's per-user budget is unused)
    // AND that the IP budget caps aggregate traffic regardless of how many
    // distinct users sit behind it (never a composite key).
    const blocked = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "nat-user-4")
      .send({ question: VALID_QUESTION });
    strictEqual(
      blocked.status,
      429,
      "61st request from the same IP must be blocked by the per-IP limiter even for a brand-new user",
    );
  });
});

// =============================================================================
// Step 6 (part 2): upstream fetch bounded by AbortSignal.timeout
// =============================================================================

describe("recommend upstream fetch bounded by AbortSignal.timeout (Task 9 Step 6)", () => {
  const env = scopedEnv([
    "RECOMMENDER_URL",
    "RECOMMENDER_INTERNAL_KEY",
    "RECOMMENDER_FETCH_TIMEOUT_MS",
  ]);

  // A local server that accepts the connection but NEVER responds, so the
  // fetch hangs until AbortSignal.timeout fires.
  let hangingServer: http.Server;
  let hangingUrl: string;

  before(async () => {
    hangingServer = http.createServer((_req, res) => {
      // Intentionally never call res.end() — simulate a hung upstream.
      res.socket?.setKeepAlive?.(true);
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    const addr = hangingServer.address();
    if (addr == null || typeof addr === "string") {
      throw new Error("failed to bind hanging test server");
    }
    hangingUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  });

  test("a hung recommender returns 502 within the fetch timeout, not a hang", async () => {
    // Short timeout override so the test is fast; production runs the 10s
    // default (the override is a test-only escape hatch). scopedEnv's after()
    // restores these to unset once the describe finishes.
    process.env.RECOMMENDER_FETCH_TIMEOUT_MS = "150";
    process.env.RECOMMENDER_URL = hangingUrl;
    process.env.RECOMMENDER_INTERNAL_KEY = "test-internal-key";

    const { createRecommendRouter } = await import("../../routes/recommend");
    const app = createRecommendTestApp(createRecommendRouter());

    const started = Date.now();
    const res = await request(app)
      .post("/api/recommend")
      .set("x-test-user-sub", "user-timeout")
      .send({ question: VALID_QUESTION });
    const elapsed = Date.now() - started;

    // 502 = the catch block's clean failure response; NOT 503 (that would
    // mean it took the "not configured" branch and never tried to fetch) and
    // definitely not a multi-second hang.
    strictEqual(
      res.status,
      502,
      `a hung recommender must surface as 502 within the timeout (got ${res.status})`,
    );
    ok(
      elapsed < 2_000,
      `fetch should abort well under the 10s production default (took ${elapsed}ms with a 150ms override)`,
    );
  });
});
