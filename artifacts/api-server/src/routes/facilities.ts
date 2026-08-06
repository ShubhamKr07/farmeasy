import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  organizationsTable,
  facilitiesTable,
  roomsTable,
  usersTable,
  organizationMembersTable,
  wizardProgressTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

const CreateFacilitySchema = z.object({
  farmName: z.string().min(1),
  facilityName: z.string().min(1).optional(),
  timezone: z.string().min(1),
  units: z.enum(["metric", "imperial"]),
  currency: z.string().length(3),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// POST /facilities — W2 farm-basics submit (WIZ-001/TEN-001/TEN-003), and
// TEN-008's "Add facility" re-entry into the same wizard for an org that
// already has one or more facilities. Creates an organization (first-time
// only — see below), a facility, and its 3 index-1 rooms
// (seeding/fertigation/harvesting) in a single transaction.
//
// First-time (no existing organization_members row for this user): creates
// a brand-new organization too, and assigns the user as its owner.
// TEN-008 "Add facility" (user already has an active organization_members
// row): reuses that same organization — creates only the new facility + its
// 3 rooms, no new organization, no new membership row (they're already a
// member). This is what "Add facility loops the wizard for an org that
// already exists" means at the data layer — one org, many facilities, no
// per-user gate left (TEN-001's "exactly one organization per user" is
// unchanged and still enforced by organization_members' own unique index on
// user_id; TEN-008 only removes the one-*facility*-per-org assumption).
router.post("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(CreateFacilitySchema, req.body, res);
    if (!body) return;

    const result = await db.transaction(async (tx) => {
      const [existingMembership] = await tx
        .select({ organizationId: organizationMembersTable.organizationId })
        .from(organizationMembersTable)
        .where(
          and(eq(organizationMembersTable.userId, userId!), eq(organizationMembersTable.status, "active")),
        )
        .limit(1);

      let organizationId: number;
      if (existingMembership) {
        organizationId = existingMembership.organizationId;
      } else {
        const [org] = await tx
          .insert(organizationsTable)
          .values({ name: body.farmName })
          .returning();
        organizationId = org.id;
        await tx
          .update(usersTable)
          .set({ organizationId: org.id })
          .where(eq(usersTable.id, userId!));
        await tx.insert(organizationMembersTable).values({
          organizationId: org.id,
          userId: userId!,
          role: "owner",
          status: "active",
        });
      }

      const [facility] = await tx
        .insert(facilitiesTable)
        .values({
          name: body.farmName,
          organizationId,
          facilityName: body.facilityName || body.farmName,
          timezone: body.timezone,
          units: body.units,
          currency: body.currency,
        })
        .returning();
      await tx.insert(roomsTable).values([
        { name: "seeding", sortOrder: 0, facilityId: facility.id },
        { name: "fertigation", sortOrder: 1, facilityId: facility.id },
        { name: "harvesting", sortOrder: 2, facilityId: facility.id },
      ]);
      return { facilityId: facility.id, organizationId };
    });

    return res.status(201).json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility" });
  }
});

// GET /facilities/me — used by the wizard's own Done screen (Done.tsx) to
// show the name of the facility the signed-in user just finished onboarding.
// Resolves via wizard_progress's own facilityId (the row for whichever
// wizard run is currently active/most-recently-updated for this user), NOT
// "the org's facility" — once an org can hold 2+ facilities (TEN-008), the
// latter would non-deterministically return the wrong one for every "Add
// facility" run after the first.
router.get("/facilities/me", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [progress] = await db
      .select({ facilityId: wizardProgressTable.facilityId })
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, userId!))
      .orderBy(desc(wizardProgressTable.updatedAt))
      .limit(1);
    if (!progress?.facilityId) return res.status(200).json(null);
    const [facility] = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, progress.facilityId));
    return res.status(200).json(facility ? { ...facility, onboarded: true } : null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facility" });
  }
});

// GET /facilities — the org's full facility list, for the web/mobile
// switcher (TEN-008). Org-scoped, not facility-scoped: resolves the
// signed-in user's organization directly via organization_members (the same
// bootstrap-safe pattern resolveTenantContext itself uses), deliberately NOT
// gated by requireTenantContext/X-Facility-Id — the switcher needs this list
// BEFORE any facility has been chosen, so requiring the header here would be
// circular.
//
// `onboarded` is derived from wizard_progress's own per-(user, facility)
// row, not facility-readiness's 7-item checklist `completedCount` — the
// switcher only needs "is this facility's onboarding wizard done," which
// wizard_progress already answers directly; recomputing the full readiness
// checklist for every facility in the list would duplicate real business
// logic (sensors/cycles/QBO counts) with no proven need for this list view.
router.get("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [membership] = await db
      .select({ organizationId: organizationMembersTable.organizationId })
      .from(organizationMembersTable)
      .where(
        and(eq(organizationMembersTable.userId, userId!), eq(organizationMembersTable.status, "active")),
      )
      .limit(1);
    if (!membership) return res.status(200).json([]);

    const facilities = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.organizationId, membership.organizationId))
      .orderBy(facilitiesTable.createdAt);

    const progressRows = await db
      .select({ facilityId: wizardProgressTable.facilityId, currentStep: wizardProgressTable.currentStep })
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, userId!));
    const doneFacilityIds = new Set(
      progressRows.filter((r) => r.currentStep === "done").map((r) => r.facilityId),
    );

    return res.status(200).json(
      facilities.map((f) => ({ ...f, onboarded: doneFacilityIds.has(f.id) })),
    );
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facilities" });
  }
});

export default router;
