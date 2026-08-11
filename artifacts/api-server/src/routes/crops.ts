import { Router, type Request, type Response } from "express";
import { or, isNull, eq } from "drizzle-orm";
import { withTenantScope } from "@workspace/db";
import { cropsTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();

function formatCrop(c: typeof cropsTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    scientificName: c.scientificName ?? null,
    category: c.category ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

// MT-M2 batch 3: crops is a hybrid org-scoped catalog (system crops with
// organization_id NULL, readable by everyone, plus each org's own private
// crops). Both routes run under withTenantScope so app.org_id is set for
// 00022_crops_rls.sql's role-agnostic policies -- an additional defense-in-
// depth layer, not the only filter (see GET's explicit WHERE below). This
// mirrors every other tenant-scoped route in this codebase (alerts.ts,
// growthProfiles.ts, ...): the app ALSO filters explicitly rather than
// relying on RLS alone, both because a least-privilege role should never be
// the sole safety net and because the disposable-Supabase CI stack this
// suite runs against connects as `postgres` (BYPASSRLS) -- RLS is a genuine
// no-op there (see docs/runbooks/tenancy-db-role.md), so an RLS-only SELECT
// would silently return every org's rows in CI even though it would
// correctly filter under staging/production's real farmsmart_app role.
// requireTenantContext (per-route -- tier 1, same category as
// growthProfiles.ts/seedLots.ts) gates both: crops was previously mounted
// fully ungated, but the RLS SELECT policy returns 0 rows without app.org_id
// set, so an unscoped call would silently come back empty rather than
// erroring -- gating makes the missing X-Facility-Id an explicit 400
// instead. No dashboard/farmeasy client calls GET/POST /crops today
// (verified: no listCrops/createCrop/CropsApi reference in either
// codebase), so this gating change has no live-feature regression risk.
router.get("/crops", requireTenantContext, async (req: Request, res: Response) => {
  try {
    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(cropsTable)
        .where(or(isNull(cropsTable.organizationId), eq(cropsTable.organizationId, req.tenant!.organizationId)))
        .orderBy(cropsTable.name),
    );
    return res.json(rows.map(formatCrop));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch crops" });
  }
});

router.post("/crops", requireTenantContext, async (req: Request, res: Response) => {
  try {
    const { name, scientificName, category } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const [c] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(cropsTable)
        .values({
          name,
          scientificName: scientificName ?? null,
          category: category ?? null,
          organizationId: req.tenant!.organizationId,
        })
        .returning(),
    );
    return res.status(201).json(formatCrop(c!));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create crop" });
  }
});

export default router;
