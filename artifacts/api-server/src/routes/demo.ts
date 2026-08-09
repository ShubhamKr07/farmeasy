import { Router, type Request, type Response } from "express";
import { sql, and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  facilitiesTable,
  wizardProgressTable,
  seedDemoOrg,
} from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";
import { isDemoForkEnabled } from "../lib/demoFork";

const router = Router();

/**
 * Resolves the caller's org from their active OWNER membership, NEVER from
 * req.tenant/X-Facility-Id — the demo fork runs at W2, before any facility
 * exists, so there is no tenant context to resolve yet (mirrors
 * wizard.ts's getOrganizationId, but additionally filtered to role="owner":
 * only the org's owner may provision/graduate the demo, matching TEN-012's
 * one-org-per-user, owner-created-it invariant). Returns null for both "no
 * membership at all" and "a membership that isn't an active owner" — the
 * caller can't tell the two apart from this alone, but both collapse to the
 * same 403 response below, so the distinction doesn't matter to callers.
 */
async function getOwnerOrg(userId: string): Promise<number | null> {
  const [membership] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.userId, userId),
        eq(organizationMembersTable.status, "active"),
        eq(organizationMembersTable.role, "owner"),
      ),
    )
    .limit(1);
  return membership?.organizationId ?? null;
}

// GET /demo/status — read-only, always available (never flag-gated: a demo
// user already in a demo org must always be able to see their own state,
// even with DEMO_FORK_ENABLED later switched off — see demoFork.ts's own
// note). No owner org resolves to isDemo:false/demoFacilityId:null rather
// than an error, since a brand-new user with no org yet is a normal state at
// W2, not a failure.
router.get("/demo/status", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const organizationId = await getOwnerOrg(userId!);
    if (!organizationId) {
      return res.status(200).json({ enabled: isDemoForkEnabled(), isDemo: false, demoFacilityId: null });
    }

    const [org] = await db
      .select({ isDemo: organizationsTable.isDemo })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));

    let demoFacilityId: number | null = null;
    if (org?.isDemo) {
      const [facility] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(eq(facilitiesTable.organizationId, organizationId))
        .limit(1);
      demoFacilityId = facility?.id ?? null;
    }

    return res.status(200).json({ enabled: isDemoForkEnabled(), isDemo: Boolean(org?.isDemo), demoFacilityId });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch demo status" });
  }
});

// POST /demo/provision — flag-gated (403 when DEMO_FORK_ENABLED is off).
// Idempotent: an already-demo org returns its existing demo facility with no
// re-seed. Single transaction: app.org_id is set FIRST (so the 00019
// organizations UPDATE policy admits the is_demo flip), THEN the facility
// row is inserted, THEN app.facility_id is set (only meaningful once the
// facility exists), THEN seedDemoOrg runs. A wizard_progress row is written
// at currentStep:"done" for (userId, facilityId) so GET /facilities' own
// onboarded-derivation (wizard_progress.currentStep === "done" for that
// facility, see routes/facilities.ts) reports the demo facility as onboarded
// — landing the caller on the populated dashboard instead of back in the
// wizard.
router.post("/demo/provision", async (req: Request, res: Response) => {
  if (!isDemoForkEnabled()) {
    return res.status(403).json({ error: "Demo fork disabled" });
  }
  try {
    const { userId } = getAuth(req);
    const organizationId = await getOwnerOrg(userId!);
    if (!organizationId) {
      return res.status(403).json({ error: "No owner organization" });
    }

    const facilityId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${organizationId.toString()}, true)`);

      const [org] = await tx
        .select({ isDemo: organizationsTable.isDemo })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId))
        .for("update");
      if (org?.isDemo) {
        const [existing] = await tx
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.organizationId, organizationId))
          .limit(1);
        if (existing) return existing.id; // idempotent: already provisioned, no re-seed
      }

      await tx.update(organizationsTable).set({ isDemo: true }).where(eq(organizationsTable.id, organizationId));

      const [facility] = await tx
        .insert(facilitiesTable)
        .values({
          name: "Demo Farm",
          organizationId,
          facilityName: "Demo Farm",
          timezone: "America/Los_Angeles",
          units: "metric",
          currency: "USD",
        })
        .returning({ id: facilitiesTable.id });

      await tx.execute(sql`SELECT set_config('app.facility_id', ${facility.id.toString()}, true)`);

      await seedDemoOrg(tx, { organizationId, facilityId: facility.id, userId: userId! });

      await tx.insert(wizardProgressTable).values({
        userId: userId!,
        organizationId,
        facilityId: facility.id,
        currentStep: "done",
      });

      return facility.id;
    });

    return res.status(200).json({ facilityId });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to provision demo" });
  }
});

export default router;
