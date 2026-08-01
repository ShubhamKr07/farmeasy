import { describe, test, before, mock } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { createAuthenticatedTestApp } from "../helpers/testApp";

/**
 * Health vs readiness split (Release 1 Task 10, Node side).
 *
 * `/healthz` is process-liveness only — zero I/O, must never depend on DB
 * reachability so a DB blip doesn't kill mobile's liveness signal. The smoke
 * assertion below re-locks that: it passes with NO database wired at all.
 *
 * `/readyz` runs `SELECT 1` against the DB with a 2-second budget and returns
 * 503 if the check fails or exceeds it. The timeout path is the hard one to
 * prove without a real slow database, so the slow-DB test stubs `pool.connect`
 * to return a client whose `query` never resolves — the route's 2s
 * client-side budget must fire and respond 503 within a bounded wall-clock
 * window (not a real slow query).
 *
 * This file does NOT need TEST_DATABASE_URL: every case either avoids the DB
 * (/healthz) or controls the DB call's timing via a stub. @workspace/db reads
 * DATABASE_URL at module load and throws if unset, so we point it at a
 * loopback string — `ssl: false`, no DATABASE_CA_CERT required — before the
 * lazy dynamic import. No real connection is ever opened (pool.connect is
 * mocked in every /readyz case).
 */
// Loopback so lib/db's buildSslConfig returns ssl:false (no DATABASE_CA_CERT
// needed). The string is never actually connected to.
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@127.0.0.1:5432/health-test";

// Lazy handles — populated once by the `before` hook. @workspace/db is
// imported dynamically so its module-level Pool is constructed AFTER
// DATABASE_URL is set above, exactly the pattern useDatabaseFixture uses.
let healthRouter: Awaited<
  typeof import("../../routes/health")
>["default"];
let pool: Awaited<typeof import("@workspace/db")>["pool"];

before(async () => {
  const health = await import("../../routes/health");
  healthRouter = health.default;
  const db = await import("@workspace/db");
  pool = db.pool;
});

describe("GET /healthz", () => {
  test("returns 200 {status:'ok'} with no database involvement", async () => {
    const app = createAuthenticatedTestApp(healthRouter);
    const res = await request(app).get("/api/healthz");

    strictEqual(res.status, 200);
    strictEqual(res.body.status, "ok");
  });

  test("stays 200 even when the database is unreachable", async () => {
    // /healthz must NOT touch the DB: stub pool.connect to throw and confirm
    // the liveness probe still answers 200 (a DB blip must never look like a
    // process crash to mobile clients polling this endpoint).
    const app = createAuthenticatedTestApp(healthRouter);
    const connectMock = mock.method(pool, "connect", () => {
      throw new Error("database is down");
    });

    try {
      const res = await request(app).get("/api/healthz");
      strictEqual(res.status, 200);
      strictEqual(res.body.status, "ok");
    } finally {
      connectMock.mock.restore();
    }
  });
});

describe("GET /readyz", () => {
  test("returns 503 when the database check exceeds the 2s budget", async () => {
    const app = createAuthenticatedTestApp(healthRouter);

    // Simulate a hung/slow DB: the checked-out client's query never resolves.
    // Postgres's statement_timeout would abort this server-side in
    // production, but here we prove the route's own 2s client-side budget
    // fires and answers 503 — within a bounded wall-clock window, without a
    // real slow database.
    const hangingClient = {
      query: () => new Promise<never>(() => {}),
      release: () => {},
    };
    const connectMock = mock.method(pool, "connect", () => hangingClient);

    try {
      const start = Date.now();
      const res = await request(app).get("/api/readyz");
      const elapsed = Date.now() - start;

      strictEqual(res.status, 503);
      strictEqual(res.body.error, "Database not ready");
      // The timeout actually fired (not an instant error): waited ~2s...
      ok(
        elapsed >= 1900,
        `expected the 2s budget to elapse (>=1.9s), took ${elapsed}ms`,
      );
      // ...and is bounded (didn't hang waiting on the never-resolving query).
      ok(
        elapsed < 4000,
        `expected the response within a bounded window (<4s), took ${elapsed}ms`,
      );
    } finally {
      connectMock.mock.restore();
    }
  });

  test("returns 503 when the database query rejects", async () => {
    const app = createAuthenticatedTestApp(healthRouter);

    // Connect succeeds but the probe query errors (e.g. TLS/auth failure).
    // Should fail fast — no need to wait the full 2s budget.
    const failingClient = {
      query: () => Promise.reject(new Error("connection refused")),
      release: () => {},
    };
    const connectMock = mock.method(pool, "connect", () => failingClient);

    try {
      const start = Date.now();
      const res = await request(app).get("/api/readyz");
      const elapsed = Date.now() - start;

      strictEqual(res.status, 503);
      strictEqual(res.body.error, "Database not ready");
      // Fast failure: query rejected immediately, not via the 2s timer.
      ok(
        elapsed < 1000,
        `expected fast failure (<1s), took ${elapsed}ms`,
      );
    } finally {
      connectMock.mock.restore();
    }
  });

  test("returns 503 when pool.connect itself never resolves", async () => {
    const app = createAuthenticatedTestApp(healthRouter);

    // Simulates a pool-exhaustion / network stall: connect() hangs. The
    // statement_timeout can't help (no connection yet) — the client-side
    // Promise.race must bound this.
    const connectMock = mock.method(
      pool,
      "connect",
      () => new Promise<never>(() => {}),
    );

    try {
      const start = Date.now();
      const res = await request(app).get("/api/readyz");
      const elapsed = Date.now() - start;

      strictEqual(res.status, 503);
      ok(
        elapsed >= 1900,
        `expected the 2s budget to elapse (>=1.9s), took ${elapsed}ms`,
      );
      ok(
        elapsed < 4000,
        `expected the response within a bounded window (<4s), took ${elapsed}ms`,
      );
    } finally {
      connectMock.mock.restore();
    }
  });

  test("returns 200 {status:'ok'} when SELECT 1 succeeds", async () => {
    const app = createAuthenticatedTestApp(healthRouter);

    // Success path: SET statement_timeout + SELECT 1 both resolve. No real
    // database — the stub controls the query result entirely.
    const okClient = {
      query: () => Promise.resolve({ rows: [{ "?column?": 1 }] }),
      release: () => {},
    };
    const connectMock = mock.method(pool, "connect", () => okClient);

    try {
      const res = await request(app).get("/api/readyz");

      strictEqual(res.status, 200);
      strictEqual(res.body.status, "ok");
    } finally {
      connectMock.mock.restore();
    }
  });
});
