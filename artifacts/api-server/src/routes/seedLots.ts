import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { eq, and } from "drizzle-orm";
import { withTenantScope, seedLotsTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();

const seedLotLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

router.get("/seed-lots/lookup", seedLotLookupLimiter, requireTenantContext, async (req: Request, res: Response) => {
  try {
    const qrCode = req.query.qrCode as string;
    if (!qrCode) {
      return res.status(400).json({ error: "qrCode query parameter is required" });
    }

    const [lot] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(seedLotsTable)
        .where(and(eq(seedLotsTable.qrCode, qrCode), eq(seedLotsTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!lot) {
      return res.status(404).json({ error: "Seed lot not found" });
    }

    return res.json(lot);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to lookup seed lot" });
  }
});

export default router;
