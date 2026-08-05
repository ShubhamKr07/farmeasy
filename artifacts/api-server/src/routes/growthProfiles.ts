import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, withTenantScope, organizationsTable, facilitiesTable, growthProfilesTable, seedLotsTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();

export async function seedDataIfEmpty() {
  try {
    const existing = await db
      .select({ id: growthProfilesTable.id })
      .from(growthProfilesTable)
      .limit(1);
    if (existing.length > 0) return;

    // Pilot-only bootstrap seed, NOT a per-tenant operation — it runs once at
    // process startup with no request/session to derive real tenant context
    // from (same category as overdue-scanner.ts, more so). Deliberately kept
    // on the pilot-default resolution pattern MT-M1 retires everywhere else:
    // TEN-013 (demo mode, MT-M2) is what properly replaces this with real
    // per-organization starter-data provisioning at facility-creation time.
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).orderBy(organizationsTable.id).limit(1);
    const [facility] = await db.select({ id: facilitiesTable.id }).from(facilitiesTable).orderBy(facilitiesTable.id).limit(1);
    if (!org || !facility) {
      console.log("Skipping pilot seed: no organization/facility exists yet");
      return;
    }

    await db.insert(growthProfilesTable).values([
      { name: "Arugula (Normal)", seedName: "Arugula", germinationDays: 7, fertigationDays: 14, organizationId: org.id },
      { name: "Allstar Gourmet Lettuce Mix", seedName: "Allstar Gourmet Lettuce Mix", germinationDays: 5, fertigationDays: 18, organizationId: org.id },
      { name: "Toscano Kale", seedName: "Toscano Kale", germinationDays: 5, fertigationDays: 21, organizationId: org.id },
      { name: "Zephyr Summer Squash (Normal)", seedName: "Zephyr Summer Squash", germinationDays: 4, fertigationDays: 10, organizationId: org.id },
      { name: "Microgreen Mix", seedName: "Microgreen Mix", germinationDays: 3, fertigationDays: 7, organizationId: org.id },
    ]);

    await db.insert(seedLotsTable).values([
      { qrCode: "LOT-3740", seedName: "Arugula", facilityId: facility.id },
      { qrCode: "LOT-3741", seedName: "Allstar Gourmet Lettuce Mix", facilityId: facility.id },
      { qrCode: "LOT-3742", seedName: "Toscano Kale", facilityId: facility.id },
      { qrCode: "LOT-3743", seedName: "Zephyr Summer Squash", facilityId: facility.id },
      { qrCode: "LOT-3744", seedName: "Microgreen Mix", facilityId: facility.id },
    ]);

    console.log("Seed data inserted");
  } catch (err) {
    console.error("Seeding failed:", err);
  }
}

router.get("/growth-profiles", requireTenantContext, async (req: Request, res: Response) => {
  try {
    const profiles = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(growthProfilesTable).where(eq(growthProfilesTable.organizationId, req.tenant!.organizationId)),
    );
    res.json(profiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch growth profiles" });
  }
});

export default router;
