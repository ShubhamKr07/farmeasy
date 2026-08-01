import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { wizardProgressTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
// The read-existing-stepData-then-write is done inside a transaction with a
// locking `SELECT ... FOR UPDATE` (same precedent as facilities.ts's
// already-has-a-facility check), not a plain read beforehand: two concurrent
// PUTs for the same user (double-click submit, two open tabs) — one saving a
// draft, one an advance-only call with no stepData — would otherwise be able
// to interleave their read and write, letting the advance-only call silently
// overwrite the just-saved draft with stale/empty stepData (a lost update).
// With the lock, the second PUT's SELECT blocks until the first PUT's
// transaction commits, then reads the up-to-date stepData.
router.put("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(PutWizardProgressSchema, req.body, res);
    if (!body) return;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));

    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ stepData: wizardProgressTable.stepData })
        .from(wizardProgressTable)
        .where(eq(wizardProgressTable.userId, userId!))
        .for("update");

      // Only overwrite stepData when the caller actually sent a draft
      // payload; a plain "advance to next step" PUT (currentStep only) must
      // not blow away the previous step's already-saved draft.
      const stepData = body.stepData ?? existing?.stepData ?? {};

      const [updated] = await tx
        .insert(wizardProgressTable)
        .values({
          userId: userId!,
          organizationId: user?.organizationId ?? null,
          currentStep: body.currentStep,
          stepData,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: wizardProgressTable.userId,
          set: {
            currentStep: body.currentStep,
            stepData,
            updatedAt: new Date(),
          },
        })
        .returning({
          currentStep: wizardProgressTable.currentStep,
          stepData: wizardProgressTable.stepData,
        });
      return updated;
    });

    return res.status(200).json(row);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to save wizard progress" });
  }
});

export default router;
