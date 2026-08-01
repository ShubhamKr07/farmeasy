import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "@workspace/db";
import { wizardEventsTable } from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";

const WizardEventSchema = z.object({
  step: z.enum(["farm_basics", "layout", "sensors_accounts", "sensors_devices", "sensors_review", "done"]),
  eventType: z.enum(["view", "save", "abandon", "skip"]),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

const WIZARD_EVENTS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const WIZARD_EVENTS_RATE_LIMIT = 120; // generous — this endpoint is called on every step view/save,
// not a security control, just defense against an accidental render-loop hammering it (see brief Step 1).

/**
 * Build a fresh wizard-events router with its OWN rate-limit store.
 *
 * `app.ts` calls this once at startup for the default export. Tests call it
 * per-suite (same pattern as `createSensorAccountsRouter`/`createRecommendRouter`)
 * so each describe block gets an isolated process-local MemoryStore for
 * `wizardEventsLimiter` — without that, a plain module-level singleton
 * limiter would have its counters shared (via Node's ESM import cache)
 * across every describe block in a test file, letting one suite's requests
 * count against another's budget.
 */
export function createWizardEventsRouter(): Router {
  const router = Router();

  const wizardEventsLimiter = rateLimit({
    windowMs: WIZARD_EVENTS_RATE_LIMIT_WINDOW_MS,
    limit: WIZARD_EVENTS_RATE_LIMIT,
    keyGenerator: (req) => getAuth(req).userId ?? "anon",
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many telemetry events. Please try again later." });
    },
    legacyHeaders: false,
  });

  router.post("/wizard-events", wizardEventsLimiter, async (req: Request, res: Response) => {
    try {
      const { userId } = getAuth(req);
      const body = validate(WizardEventSchema, req.body, res);
      if (!body) return;

      await db.insert(wizardEventsTable).values({
        userId: userId!,
        step: body.step,
        eventType: body.eventType,
      });
      return res.status(202).end();
    } catch (err) {
      req.log.error(err);
      return res.status(500).json({ error: "Failed to record wizard event" });
    }
  });

  return router;
}

const wizardEventsRouter = createWizardEventsRouter();
export default wizardEventsRouter;
