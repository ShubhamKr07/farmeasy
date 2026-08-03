import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { seedLotsTable, facilitiesTable } from "@workspace/db";

const router = Router();

const seedLotLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

router.get("/seed-lots/lookup", seedLotLookupLimiter, async (req, res) => {
  try {
    const qrCode = req.query.qrCode as string;
    if (!qrCode) {
      return res.status(400).json({ error: "qrCode query parameter is required" });
    }

    // Facility resolution from session context is MT-M1 wiring (this
    // handler doesn't yet have a scoped-session helper to call) — use the
    // pilot default facility id for now, matching every other pre-MT-M1
    // handler in this codebase (see Task 4's typecheck note).
    const [defaultFacility] = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .orderBy(facilitiesTable.id)
      .limit(1);
    if (!defaultFacility) {
      return res.status(500).json({ error: "No facility configured" });
    }
    const facilityId = defaultFacility.id;

    const [lot] = await db
      .select()
      .from(seedLotsTable)
      .where(and(eq(seedLotsTable.qrCode, qrCode), eq(seedLotsTable.facilityId, facilityId)))
      .limit(1);

    if (!lot) {
      return res.status(404).json({ error: "Seed lot not found" });
    }

    return res.json(lot);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to lookup seed lot" });
  }
});

export default router;
