import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { wizardProgressTable, usersTable, organizationMembersTable, facilitiesTable } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
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
  facilityId: z.number().int().positive().optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

/**
 * Resolves which organization the signed-in user belongs to (or null for a
 * brand-new user who hasn't reached W2 yet). Deliberately NOT req.tenant —
 * this route pair is the one deliberate exception to X-Facility-Id being
 * hard-required (TEN-008 design doc, §Architecture): there is no facility to
 * name yet for a brand-new wizard run, and re-entering the wizard for an
 * existing facility identifies it via the `facilityId` query
 * param/request-body field below, not the header.
 */
async function getOrganizationId(userId: string): Promise<number | null> {
  const [membership] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(and(eq(organizationMembersTable.userId, userId), eq(organizationMembersTable.status, "active")))
    .limit(1);
  return membership?.organizationId ?? null;
}

// GET /wizard/progress — resume support (WIZ-001), now per-facility
// (TEN-008). `?facilityId=<id>` resumes an EXISTING facility's wizard run
// (re-entering "Add facility" for a facility whose W2 already succeeded but
// a later step didn't finish) — validated against the user's own
// organization before use, same re-validation discipline as
// resolveTenantContext. Omitted: resumes the user's current in-progress,
// not-yet-facility-created run (facility_id IS NULL) — the common case for
// both first-time onboarding and the very start of "Add facility," before
// W2's POST /facilities has run yet. Returns null if no matching row exists,
// so the client's Wizard.tsx defaults to the first step instead of treating
// this as an error.
router.get("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const facilityIdParam = req.query.facilityId;

    let facilityCondition;
    if (typeof facilityIdParam === "string" && facilityIdParam.trim() !== "") {
      const facilityId = Number(facilityIdParam);
      if (!Number.isInteger(facilityId) || facilityId <= 0) {
        return res.status(400).json({ error: "Invalid facilityId" });
      }
      const organizationId = await getOrganizationId(userId!);
      const [facility] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(and(eq(facilitiesTable.id, facilityId), eq(facilitiesTable.organizationId, organizationId ?? -1)));
      if (!facility) return res.status(400).json({ error: "Facility not found in your organization" });
      facilityCondition = eq(wizardProgressTable.facilityId, facilityId);
    } else {
      facilityCondition = isNull(wizardProgressTable.facilityId);
    }

    const [row] = await db
      .select({
        facilityId: wizardProgressTable.facilityId,
        currentStep: wizardProgressTable.currentStep,
        stepData: wizardProgressTable.stepData,
      })
      .from(wizardProgressTable)
      .where(and(eq(wizardProgressTable.userId, userId!), facilityCondition));
    return res.status(200).json(row ?? null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch wizard progress" });
  }
});

// PUT /wizard/progress — save the current step's draft data and/or advance
// currentStep. TEN-008: body.facilityId, once known (set right after W2's
// POST /facilities succeeds), both identifies which row to update (a real
// facility's row, not the null-facility "which facility am I even creating"
// row) AND, on the one PUT call that first supplies it, transitions that
// exact null-facility row into a real-facility row via an UPDATE keyed on
// (userId, facilityId IS NULL) — never a second INSERT, so the same
// partial-unique-index invariant (Task 3) that limits a user to one
// in-progress unassigned run is never raced.
//
// This must be a single atomic statement, not a read-then-write (even a
// transaction with `SELECT ... FOR UPDATE` isn't enough — see below). Two
// concurrent PUTs for the same (user, facility) — one saving a draft, one an
// advance-only call with no stepData — must never let the advance-only
// call's write clobber the draft-save's write, regardless of which one
// Postgres actually commits first.
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

    if (body.facilityId !== undefined) {
      // Validate the facility actually belongs to the user's own
      // organization before ever writing it onto their wizard_progress row —
      // same re-validation discipline as resolveTenantContext/getAuth
      // elsewhere in this milestone, never trust a client-supplied id
      // outright.
      const organizationId = await getOrganizationId(userId!);
      const [facility] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(and(eq(facilitiesTable.id, body.facilityId), eq(facilitiesTable.organizationId, organizationId ?? -1)));
      if (!facility) {
        return res.status(400).json({ error: "facilityId not found in your organization" });
      }

      const [row] = await db
        .update(wizardProgressTable)
        .set({
          facilityId: body.facilityId,
          currentStep: body.currentStep,
          stepData:
            body.stepData !== undefined
              ? sql`${JSON.stringify(body.stepData)}::jsonb`
              : sql`${wizardProgressTable.stepData}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wizardProgressTable.userId, userId!), isNull(wizardProgressTable.facilityId)))
        .returning({
          facilityId: wizardProgressTable.facilityId,
          currentStep: wizardProgressTable.currentStep,
          stepData: wizardProgressTable.stepData,
        });

      if (row) return res.status(200).json(row);

      // No null-facility row existed to transition (e.g. re-entering an
      // already-facility-stamped run after a client-side reload) — fall
      // through to the ordinary per-facility upsert below instead of
      // erroring.
    }

    // Conflict-target note (verified against the real database, not assumed):
    // wizard_progress has two unique indexes post-Task-3 — a composite
    // (user_id, facility_id) and a PARTIAL one, `UNIQUE (user_id) WHERE
    // facility_id IS NULL`. Drizzle's `.onConflictDoUpdate({ target: ... })`
    // only accepts a column (or column array) for `target` — passing a raw
    // `sql` fragment there doesn't match this Drizzle version's type surface
    // (pg-core's PgInsertOnConflictDoUpdateConfig.target is `IndexColumn |
    // IndexColumn[]`, i.e. an actual PgColumn). A bare
    // `target: wizardProgressTable.userId` alone reproduces
    // `ON CONFLICT (user_id) DO UPDATE ...`, which Postgres rejects against a
    // partial index with "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification" (confirmed with a real psql
    // session against this exact schema). The fix is Drizzle's own
    // `targetWhere` option — it appends the same predicate the partial index
    // was created with, producing
    // `ON CONFLICT (user_id) WHERE facility_id IS NULL DO UPDATE ...`, which
    // Postgres accepts as an unambiguous arbiter (also confirmed with a real
    // psql session).
    const [row] = await db
      .insert(wizardProgressTable)
      .values({
        userId: userId!,
        organizationId: user?.organizationId ?? null,
        facilityId: body.facilityId ?? null,
        currentStep: body.currentStep,
        stepData: body.stepData ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate(
        body.facilityId !== undefined
          ? {
              target: [wizardProgressTable.userId, wizardProgressTable.facilityId],
              set: {
                currentStep: body.currentStep,
                stepData:
                  body.stepData !== undefined
                    ? sql`${JSON.stringify(body.stepData)}::jsonb`
                    : sql`${wizardProgressTable.stepData}`,
                updatedAt: new Date(),
              },
            }
          : {
              target: wizardProgressTable.userId,
              targetWhere: sql`${wizardProgressTable.facilityId} IS NULL`,
              set: {
                currentStep: body.currentStep,
                stepData:
                  body.stepData !== undefined
                    ? sql`${JSON.stringify(body.stepData)}::jsonb`
                    : sql`${wizardProgressTable.stepData}`,
                updatedAt: new Date(),
              },
            },
      )
      .returning({
        facilityId: wizardProgressTable.facilityId,
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
