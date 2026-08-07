import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db, signupAllowlistTable } from "@workspace/db";
import { getSignupMode } from "../lib/signupMode";

const SIGNUP_AVAILABILITY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// Generous ceiling for a public, pre-auth probe: real prospective users hit it
// once per landing; the cap is just a backstop against a script enumerating
// which emails are allowlisted. The handler does a single indexed lookup, so
// the budget is about information disclosure, not load.
const SIGNUP_AVAILABILITY_RATE_LIMIT = 60;

/**
 * Build a fresh auth router with its OWN rate-limit store.
 *
 * `app.ts` will call this once at startup (Task 9 mounts it under `/api`).
 * Tests call it per-suite — the same pattern as `createWizardEventsRouter` —
 * so each describe block gets an isolated process-local MemoryStore for
 * `availabilityLimiter`. A module-level singleton limiter would otherwise
 * share its counters (via Node's ESM import cache) across every suite in a
 * test file, letting one suite's requests count against another's budget.
 *
 * Task 4 will add `POST /auth/request-access` inside this same factory.
 */
export function createAuthRouter(): Router {
  const router = Router();

  const availabilityLimiter = rateLimit({
    windowMs: SIGNUP_AVAILABILITY_RATE_LIMIT_WINDOW_MS,
    limit: SIGNUP_AVAILABILITY_RATE_LIMIT,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests. Please try again later." });
    },
    legacyHeaders: false,
  });

  // GET /auth/signup-availability — public (no auth). Tells the client
  // whether sign-up is closed, allowlisted, or open so the UI can render the
  // right entry point. In allowlist mode, `email` is normalized
  // (trim + lowercase) before the lookup, matching how rows are stored.
  router.get("/auth/signup-availability", availabilityLimiter, async (req: Request, res: Response) => {
    try {
      const mode = getSignupMode();
      if (mode === "off") return res.json({ mode, allowed: false });
      if (mode === "public") return res.json({ mode, allowed: true });

      // mode === "allowlist"
      const email = String(req.query.email ?? "").trim().toLowerCase();
      if (!email) return res.json({ mode, allowed: false });
      const [row] = await db
        .select({ id: signupAllowlistTable.id })
        .from(signupAllowlistTable)
        .where(eq(signupAllowlistTable.email, email))
        .limit(1);
      return res.json({ mode, allowed: Boolean(row) });
    } catch (err) {
      req.log.error(err);
      return res.status(500).json({ error: "Failed to check sign-up availability" });
    }
  });

  return router;
}
