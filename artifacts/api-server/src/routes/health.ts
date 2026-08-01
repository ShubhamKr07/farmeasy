import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// Process-liveness probe. Mobile clients poll this, so it MUST stay free of
// any I/O: a database blip must never look like a process crash to the mobile
// liveness signal (Release 1 Task 10). Returns 200/{status:"ok"} as long as
// the Node process can answer — deliberately NOT a measure of DB reachability.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness budget for /readyz (milliseconds). Both Postgres's own
// statement_timeout AND the client-side Promise.race use this same value, so
// a slow/hung SELECT is bounded from both sides and the endpoint can never
// hang longer than this regardless of DB state.
const READINESS_TIMEOUT_MS = 2000;

/**
 * Run `SELECT 1` against the database, bounded to READINESS_TIMEOUT_MS.
 *
 * Two independent bounds, defense-in-depth:
 *   1. `SET statement_timeout` — Postgres itself aborts a slow statement
 *      server-side and frees the connection (a JS timer alone would resolve
 *      the response but leave the query running, holding a pooled client).
 *   2. `Promise.race` against the same budget — bounds pool.connect() /
 *      network stalls that statement_timeout can't reach (it's a server-side
 *      GUC that only takes effect once a connection exists and a query runs).
 *
 * Never rejects: every failure path (acquire failure, query error, timeout)
 * resolves to `false` so the route handler can't throw on a probe failure.
 */
async function isDatabaseReachable(): Promise<boolean> {
  const probe = runReadinessProbe();
  const timer = new Promise<false>((resolve) =>
    setTimeout(() => resolve(false), READINESS_TIMEOUT_MS),
  );
  return Promise.race([probe, timer]);
}

async function runReadinessProbe(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      // statement_timeout is per-session on this checked-out client; it's
      // reset when the client returns to the pool only if the next query
      // sets its own — which is fine here because every real query in the
      // app is short, and a stale 2s cap only ever helps bound runaway ones.
      await client.query(`SET statement_timeout = ${READINESS_TIMEOUT_MS}`);
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    // Connect failure, TLS failure, query error, or statement_timeout abort —
    // all mean "not ready" from Render's traffic-routing perspective.
    return false;
  }
}

// Readiness probe (Render's healthCheckPath). Distinct from /healthz: this
// one DOES depend on DB reachability. Render uses it to decide whether to
// route traffic to this instance, so a DB-down instance is pulled from the
// pool while the Node process keeps answering /healthz for mobile. Returns
// 200/{status:"ok"} when SELECT 1 answers within the 2s budget, 503 otherwise.
router.get("/readyz", async (req: Request, res: Response) => {
  try {
    const ok = await isDatabaseReachable();
    if (ok) {
      const data = HealthCheckResponse.parse({ status: "ok" });
      res.json(data);
    } else {
      res.status(503).json({ error: "Database not ready" });
    }
  } catch (err) {
    // Defensive: isDatabaseReachable never rejects, but guard anyway.
    req.log?.error?.({ err }, "readiness check failed");
    res.status(503).json({ error: "Database not ready" });
  }
});

export default router;
