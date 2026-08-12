import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, signupAllowlistTable, accessRequestsTable } from "@workspace/db";
import { getSignupMode } from "../lib/signupMode";

const SIGNUP_AVAILABILITY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// Generous ceiling for a public, pre-auth probe: real prospective users hit it
// once per landing; the cap is just a backstop against a script enumerating
// which emails are allowlisted. The handler does a single indexed lookup, so
// the budget is about information disclosure, not load.
const SIGNUP_AVAILABILITY_RATE_LIMIT = 60;

const REQUEST_ACCESS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// A waitlist submission is a rare, one-shot action per genuine client — at
// most a couple of retries if the network blips. The cap is a backstop
// against a script spamming the public write path (each accepted request
// inserts an access_requests row); 5 over 15 min is generous for a human and
// tight for a loop.
const REQUEST_ACCESS_RATE_LIMIT = 5;

/**
 * Build a fresh auth router with its OWN rate-limit stores.
 *
 * `app.ts` will call this once at startup (Task 9 mounts it under `/api`).
 * Tests call it per-suite — the same pattern as `createWizardEventsRouter` —
 * so each describe block gets an isolated process-local MemoryStore for both
 * `availabilityLimiter` (the GET read probe) and `requestAccessLimiter` (the
 * POST waitlist write). A module-level singleton limiter would otherwise
 * share its counters (via Node's ESM import cache) across every suite in a
 * test file, letting one suite's requests count against another's budget.
 *
 * `POST /auth/request-access` has its OWN limiter (`requestAccessLimiter`),
 * separate from `availabilityLimiter`: the GET is a cheap, read-only probe a
 * client hits a few times per landing, while the POST writes a waitlist row
 * and must never be spammed. Distinct buckets mean a burst of reads can't
 * exhaust the (much smaller) write budget, and vice-versa.
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

  // Separate bucket from availabilityLimiter: a waitlist submit is a rare
  // write (it inserts an access_requests row), so it gets a much smaller
  // budget than the read-only availability probe — keeping a burst of reads
  // from exhausting the write budget (or vice-versa).
  const requestAccessLimiter = rateLimit({
    windowMs: REQUEST_ACCESS_RATE_LIMIT_WINDOW_MS,
    limit: REQUEST_ACCESS_RATE_LIMIT,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests. Please try again later." });
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // GET /auth/signup-availability — public (no auth). Tells the client
  // whether sign-up is closed, allowlisted, or open so the UI can render the
  // right entry point. In allowlist mode, `email` is normalized
  // (trim + lowercase) before the lookup, matching how rows are stored.
  router.get("/auth/signup-availability", availabilityLimiter, async (req: Request, res: Response) => {
    try {
      const mode = await getSignupMode();
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

  // POST /auth/request-access — public (no auth). Captures a waitlist entry
  // while sign-up is flag-off. Writes ONLY access_requests — it never calls
  // auth admin and never creates an org/facility/membership (Task 7 adds the
  // notify path; Task 9 mounts this router). Email is normalized
  // (trim + lowercase) BEFORE the email-format check AND before storing, so:
  //   (a) a mixed-case/whitespace input still passes `.email()` validation,
  //       and (b) the stored value matches the lowercased lookup the Task 3
  // read side performs, and (c) the unique-email conflict below dedupes
  // case/space variants instead of creating near-duplicate rows.
  const RequestAccessSchema = z.object({
    email: z
      .string()
      .transform((s) => s.trim().toLowerCase())
      .pipe(z.string().email()),
    farmName: z.string().min(1).max(120),
  });

  router.post("/auth/request-access", requestAccessLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = RequestAccessSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      }
      const email = parsed.data.email;
      const farmName = parsed.data.farmName;

      // Upsert on the unique email; the only mutable field on a re-submit is
      // farm_name. notified_at is deliberately left alone — Task 7 owns
      // setting it when a requester is actually emailed.
      await db
        .insert(accessRequestsTable)
        .values({ email, farmName })
        .onConflictDoUpdate({
          target: accessRequestsTable.email,
          set: { farmName },
        });

      return res.status(201).json({ ok: true });
    } catch (err) {
      req.log.error(err);
      return res.status(500).json({ error: "Failed to capture access request" });
    }
  });

  return router;
}
