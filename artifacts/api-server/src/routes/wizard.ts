import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { wizardProgressTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

const WIZARD_STEPS = [
  "farm_basics",
  "layout",
  "sensors_accounts",
  "sensors_devices",
  "sensors_review",
  "done",
] as const;

const PutWizardProgressSchema = z.object({
  currentStep: z.enum(WIZARD_STEPS),
  stepData: z.record(z.string(), z.unknown()).optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// GET /wizard/progress — resume support (WIZ-001). Returns null if the
// signed-in user hasn't started the wizard yet (no row), so the client's
// Wizard.tsx defaults to the first step instead of treating this as an error.
router.get("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [row] = await db
      .select({
        currentStep: wizardProgressTable.currentStep,
        stepData: wizardProgressTable.stepData,
      })
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, userId!));
    return res.status(200).json(row ?? null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch wizard progress" });
  }
});

// PUT /wizard/progress — save the current step's draft data and/or advance
// currentStep. Upserts on the unique userId index so each user has exactly
// one progress row; organizationId is carried along once the user has one
// (set by POST /facilities) purely for admin/debugging convenience — not
// read by any client code path.
//
// This must be a single atomic statement, not a read-then-write (even a
// transaction with `SELECT ... FOR UPDATE` isn't enough — see below). Two
// concurrent PUTs for the same user (double-click submit, two open tabs) —
// one saving a draft, one an advance-only call with no stepData — must never
// let the advance-only call's write clobber the draft-save's write,
// regardless of which one Postgres actually commits first.
//
// A `SELECT ... FOR UPDATE` inside a transaction closes this race only when
// a wizard_progress row already exists to lock: if the very first save for a
// brand-new user races (the common case, since nothing pre-creates this row
// at signup), both concurrent SELECTs see no row (nothing to lock), both
// compute stepData in JS from only their own request body, and only *then*
// does Postgres serialize the actual INSERTs at the row level via ON
// CONFLICT — by which point each statement's SET values were already fixed
// as static parameters. Whichever insert loses the row-level race and
// converts to the conflict-UPDATE still overwrites the winner's just-
// committed stepData with its own stale precomputed value. Same lost-update
// bug, just a narrower window (first-ever save instead of every save).
//
// Fixed by removing the separate read entirely: when this PUT sent no
// stepData, the SET clause references the target table's own stepData
// column directly (`sql`${wizardProgressTable.stepData}``) instead of a
// JS-computed value. Postgres evaluates that expression against whichever
// row actually wins the conflict, as part of conflict resolution in the same
// statement — there is no window between "read what's there" and "write"
// because there is no separate read, at any point, for any row state.
router.put("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(PutWizardProgressSchema, req.body, res);
    if (!body) return;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));

    const [row] = await db
      .insert(wizardProgressTable)
      .values({
        userId: userId!,
        organizationId: user?.organizationId ?? null,
        currentStep: body.currentStep,
        stepData: body.stepData ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: wizardProgressTable.userId,
        set: {
          currentStep: body.currentStep,
          stepData:
            body.stepData !== undefined
              ? sql`${JSON.stringify(body.stepData)}::jsonb`
              : sql`${wizardProgressTable.stepData}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        currentStep: wizardProgressTable.currentStep,
        stepData: wizardProgressTable.stepData,
      });

    return res.status(200).json(row);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to save wizard progress" });
  }
});

export default router;
