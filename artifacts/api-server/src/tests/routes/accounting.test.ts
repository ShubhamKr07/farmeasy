import { describe, test, before, after } from "node:test";
import { strictEqual, throws } from "node:assert";
import express, { type Express } from "express";
import cors from "cors";
import request from "supertest";
import {
  buildCorsOptions,
  corsOriginValidator,
  parseCorsOrigins,
} from "../../lib/cors";

/**
 * Release 1 Task 9, Steps 2-3 (Sub-task A):
 *   - CORS origin allow-list parsed from the comma-separated `CORS_ORIGINS`
 *     env var, replacing the legacy single `CORS_ORIGIN`.
 *   - Production fail-closed: empty/unset `CORS_ORIGINS` under
 *     `NODE_ENV=production` throws at startup.
 *   - Requests with NO `Origin` header (native mobile, server-to-server) are
 *     accepted unconditionally; only browser `Origin`s are matched.
 *   - The QuickBooks OAuth callback redirect now reads its own dedicated
 *     `DASHBOARD_URL`, not the CORS var.
 *
 * These specific scenarios do not need a REAL database: the CORS checks hit a
 * trivial express app wired straight to the `cors` middleware, the
 * production fail-closed check drives `buildCorsOptions` with a literal env
 * object (no global mutation), and the QuickBooks callback route returns its
 * redirect from the invalid-`state` early branch (`accounting.ts`) without
 * touching `saveConnectionFromCallback` or Postgres. So this file is NOT
 * gated on TEST_DATABASE_URL — but importing accounting.ts still requires
 * DATABASE_URL to be *set* (lib/db throws at module load if it's unset,
 * even though `pg.Pool` itself connects lazily and no query ever runs here),
 * so the last describe block sets a syntactically-valid dummy value.
 */

// --- Step 2: production fail-closed ----------------------------------------

describe("CORS_ORIGINS production fail-closed (Task 9 Step 1/2)", () => {
  test("buildCorsOptions throws when CORS_ORIGINS is unset in production", () => {
    // Empty/unset CORS_ORIGINS under NODE_ENV=production must fail startup
    // (throw) rather than silently allow-all or allow-none. buildCorsOptions
    // is what app.ts calls at module load (server boot).
    throws(
      () => buildCorsOptions({ NODE_ENV: "production" }),
      /CORS_ORIGINS/,
      "unset CORS_ORIGINS in production should throw at startup",
    );
  });

  test("buildCorsOptions throws when CORS_ORIGINS is empty/whitespace in production", () => {
    throws(
      () => buildCorsOptions({ NODE_ENV: "production", CORS_ORIGINS: " , ," }),
      /CORS_ORIGINS/,
      "whitespace-only CORS_ORIGINS in production should throw",
    );
  });

  test("buildCorsOptions does not throw when CORS_ORIGINS is set in production", () => {
    const opts = buildCorsOptions({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://dashboard.example.com",
    });
    // Function-form origin option (conditional logic), not a static value.
    if (typeof opts.origin !== "function") {
      throw new Error("expected function-form cors origin option");
    }
  });

  test("buildCorsOptions allows empty CORS_ORIGINS outside production (dev/test)", () => {
    // Non-production keeps the permissive default so local dev/tests don't
    // need to configure CORS_ORIGINS.
    const opts = buildCorsOptions({ NODE_ENV: "test" });
    if (typeof opts.origin !== "function") {
      throw new Error("expected function-form cors origin option");
    }
  });

  test("parseCorsOrigins trims and drops empty entries", () => {
    const parsed = parseCorsOrigins(
      "https://a.example.com, https://b.example.com,",
    );
    strictEqual(parsed.length, 2);
    strictEqual(parsed[0], "https://a.example.com");
    strictEqual(parsed[1], "https://b.example.com");
  });
});

// --- Step 2: origin allow-list behavior ------------------------------------

/** Minimal express app mirroring app.ts's `app.use(cors(...))` wiring. */
function corsTestApp(allowedOrigins: readonly string[]): Express {
  const app = express();
  app.use(cors({ origin: corsOriginValidator(allowedOrigins) }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS origin allow-list (Task 9 Step 2)", () => {
  const ALLOWED = ["https://dashboard.example.com", "https://staging.example.com"];

  test("untrusted Origin is rejected (no Access-Control-Allow-Origin)", async () => {
    const app = corsTestApp(ALLOWED);
    const res = await request(app)
      .get("/ping")
      .set("Origin", "https://evil.example.com");

    // The handler still runs (cors doesn't block server-side), but no CORS
    // allow-origin header is emitted, so a browser would block the response.
    strictEqual(res.status, 200);
    strictEqual(
      res.headers["access-control-allow-origin"],
      undefined,
      "untrusted origin must not get an Access-Control-Allow-Origin header",
    );
  });

  test("trusted Origin (in CORS_ORIGINS) is accepted", async () => {
    const app = corsTestApp(ALLOWED);
    const res = await request(app)
      .get("/ping")
      .set("Origin", "https://dashboard.example.com");

    strictEqual(res.status, 200);
    strictEqual(
      res.headers["access-control-allow-origin"],
      "https://dashboard.example.com",
      "trusted origin must be echoed back as Access-Control-Allow-Origin",
    );
  });

  test("second trusted Origin in the list is also accepted", async () => {
    const app = corsTestApp(ALLOWED);
    const res = await request(app)
      .get("/ping")
      .set("Origin", "https://staging.example.com");

    strictEqual(res.status, 200);
    strictEqual(
      res.headers["access-control-allow-origin"],
      "https://staging.example.com",
    );
  });

  test("request with NO Origin header is accepted regardless of CORS_ORIGINS", async () => {
    // Native mobile apps and server-to-server callers send no Origin header.
    // CORS only governs browser-originated cross-origin requests; the cors
    // package invokes the origin callback with `undefined` here, which the
    // validator allows unconditionally.
    const app = corsTestApp(ALLOWED);
    const res = await request(app).get("/ping");

    strictEqual(res.status, 200);
    // No Origin in the request -> cors emits no allow-origin header, but the
    // request itself passes through (the point: it is NOT rejected).
    strictEqual(res.headers["access-control-allow-origin"], undefined);
  });

  test("no-Origin request is accepted even with an empty allow-list", async () => {
    const app = corsTestApp([]);
    const res = await request(app).get("/ping");
    strictEqual(res.status, 200);
  });
});

// --- Step 3: QuickBooks callback uses DASHBOARD_URL -------------------------

describe("QuickBooks callback redirect uses DASHBOARD_URL (Task 9 Step 3)", () => {
  // Snapshot/restore so these env mutations don't leak to sibling suites in
  // the same node:test process.
  let savedDashboardUrl: string | undefined;
  let savedCorsOrigins: string | undefined;
  let savedCorsOrigin: string | undefined;
  let savedSupabaseUrl: string | undefined;
  let savedSupabaseKey: string | undefined;
  let savedDatabaseUrl: string | undefined;

  before(() => {
    savedDashboardUrl = process.env.DASHBOARD_URL;
    savedCorsOrigins = process.env.CORS_ORIGINS;
    savedCorsOrigin = process.env.CORS_ORIGIN;
    savedSupabaseUrl = process.env.SUPABASE_URL;
    savedSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    savedDatabaseUrl = process.env.DATABASE_URL;
    // accounting.ts imports supabaseAuth.ts, which reads SUPABASE_URL /
    // SUPABASE_SERVICE_ROLE_KEY at module load. The callback route itself
    // never authenticates (it's public), so dummy values are fine — they
    // just satisfy the module-load `.replace()` calls.
    if (process.env.SUPABASE_URL === undefined) {
      process.env.SUPABASE_URL = "https://dummy.supabase.co";
    }
    if (process.env.SUPABASE_SERVICE_ROLE_KEY === undefined) {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
    }
    // accounting.ts also imports lib/accounting/quickbooks.ts, which imports
    // `db` from @workspace/db — its module throws immediately if
    // DATABASE_URL is unset. `pg.Pool` connects lazily (no real TCP
    // connection until a query runs), and this suite's tested code path
    // (the invalid-`state` early-error branch) never queries Postgres, so a
    // syntactically-valid dummy URL is sufficient — no real/test database
    // needed. Verified: without this, importing accounting.ts throws
    // "DATABASE_URL must be set" even though no query ever runs.
    if (process.env.DATABASE_URL === undefined) {
      process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
    }
  });

  after(() => {
    restoreEnv("DASHBOARD_URL", savedDashboardUrl);
    restoreEnv("CORS_ORIGINS", savedCorsOrigins);
    restoreEnv("CORS_ORIGIN", savedCorsOrigin);
    restoreEnv("SUPABASE_URL", savedSupabaseUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", savedSupabaseKey);
    restoreEnv("DATABASE_URL", savedDatabaseUrl);
  });

  test("callback redirects to DASHBOARD_URL, not CORS_ORIGIN/CORS_ORIGINS", async () => {
    // Imported here (not at module top) so the env setup above is in place
    // when the router module is first evaluated. accountingPublicRouter's
    // callback handler reads process.env.DASHBOARD_URL at request time.
    const { accountingPublicRouter } = await import("../../routes/accounting");

    const app = express();
    app.use("/api", accountingPublicRouter);

    // Set both vars to distinct values to prove the redirect tracks
    // DASHBOARD_URL and ignores the CORS var entirely.
    process.env.DASHBOARD_URL = "https://from-dashboard-url.example.com";
    process.env.CORS_ORIGINS = "https://from-cors-origins.example.com";
    process.env.CORS_ORIGIN = "https://from-cors-origin-legacy.example.com";

    // Invalid `state` -> the route's early error branch, which issues the
    // redirect without touching QuickBooks/Postgres.
    const res = await request(app).get("/api/accounting/callback?state=bogus");

    strictEqual(res.status, 302);
    const location = res.headers.location as string;
    if (!location) throw new Error("expected a Location redirect header");
    // Redirects to the DASHBOARD_URL base, NOT either CORS var.
    if (!location.startsWith("https://from-dashboard-url.example.com")) {
      throw new Error(`redirect did not target DASHBOARD_URL: ${location}`);
    }
    if (location.includes("from-cors-origin")) {
      throw new Error(
        `redirect wrongly used legacy CORS_ORIGIN: ${location}`,
      );
    }
    if (location.includes("from-cors-origins")) {
      throw new Error(`redirect wrongly used CORS_ORIGINS: ${location}`);
    }
    // And it lands on the accounting page with the error status surfaced.
    if (!location.includes("/accounting?qbo=error")) {
      throw new Error(`unexpected redirect target/path: ${location}`);
    }
  });
});

function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}
