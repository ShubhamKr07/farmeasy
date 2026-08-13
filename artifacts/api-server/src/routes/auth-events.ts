import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "@workspace/db";
import { authEventsTable } from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";

const AuthEventSchema = z.object({
  eventType: z.enum(["signin_success", "signin_failed", "reset_request", "reset_complete", "signup_start", "signup_complete"]),
  reason: z.string().optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

const AUTH_EVENTS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_EVENTS_RATE_LIMIT = 120;

/**
 * Build a fresh auth-events router with its OWN rate-limit store.
 * Tests call this per-suite so each describe block gets an isolated MemoryStore.
 */
export function createAuthEventsRouter(): Router {
  const router = Router();

  const authEventsLimiter = rateLimit({
    windowMs: AUTH_EVENTS_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_EVENTS_RATE_LIMIT,
    keyGenerator: (req) => getAuth(req).userId ?? "anon",
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many telemetry events. Please try again later." });
    },
    legacyHeaders: false,
  });

  router.post("/auth-events", authEventsLimiter, async (req: Request, res: Response) => {
    try {
      const { userId } = getAuth(req);
      const body = validate(AuthEventSchema, req.body, res);
      if (!body) return;

      await db.insert(authEventsTable).values({
        userId: userId ?? null,
        eventType: body.eventType,
        reason: body.reason ?? null,
      });
      return res.status(202).end();
    } catch (err) {
      req.log.error(err);
      return res.status(500).json({ error: "Failed to record auth event" });
    }
  });

  return router;
}

const authEventsRouter = createAuthEventsRouter();
export default authEventsRouter;
