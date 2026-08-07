import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { eq, ne, desc, and } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  cyclesTable,
  growthProfilesTable,
  manualChecksTable,
  sensorStatusTable,
  badTrayEntriesTable,
  withTenantScope,
} from "@workspace/db";
import { calcDaysOverdue, generateShortId, seedingWeight } from "../lib/utils";
import { signMediaReferences } from "../services/mediaUrls";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();
// TEN-008: every route below reads req.tenant! (via withTenantScope) with a
// non-null assertion -- resolveTenantContext (mounted upstream in app.ts)
// never guarantees req.tenant is set (missing/invalid X-Facility-Id, or a
// facility id belonging to an organization this user isn't an active member
// of both leave it unset, by design -- see tenantContext.ts). Before this
// gate, those cases fell through to withTenantScope's own defensive throw
// ("called without a resolvable organization context"), caught by each
// route's catch block and surfaced as a bare 500 -- masking what is really a
// client-bug-class 400, and inconsistent with every sibling tenant-scoped
// router (growthProfiles.ts, seedLots.ts, facility-readiness.ts), which all
// already gate on requireTenantContext. Caught for real by TEN-008 Task 12's
// same-org two-facility isolation tests (missing/cross-org X-Facility-Id
// against GET /cycles).
router.use(requireTenantContext);

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateCycleSchema = z
  .object({
    seedLotQrCodes: z.array(z.string().min(1)).min(1, "At least one seed lot required"),
    seedName: z.string().min(1).max(200),
    fullTrays: z.number().int().min(0),
    halfTrays: z.number().int().min(0),
    seedWeightTray: z.number().positive(),
    growthProfileId: z.number().int().positive(),
    seedingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    trayPosition: z.string().max(200).optional(),
    humidity: z.number().optional(),
    temperature: z.number().optional(),
    ph: z.number().optional(),
    waterLevel: z.number().optional(),
    nutrientMix: z.string().optional(),
  })
  .refine((d) => d.fullTrays > 0 || d.halfTrays > 0, {
    message: "At least one tray (full or half) is required",
  });

const FertigationSchema = z.object({
  seedLotQrCode: z.string().optional(),
  humidity: z.number().optional(),
  temperature: z.number().optional(),
  ph: z.number().optional(),
  waterLevel: z.number().optional(),
  nutrientMix: z.string().optional(),
});

const StartHarvestSchema = z.object({
  trayQrCode: z.string().optional(),
});

const CompleteHarvestSchema = z.object({
  fullTrays: z.number().int().min(0).optional(),
  halfTrays: z.number().int().min(0).optional(),
  harvestedQty: z.number().positive("harvestedQty must be a positive number"),
  trayQrCode: z.string().optional(),
  isBadTrays: z.boolean().optional(),
  issue: z.string().optional(),
});

const ManualCheckSchema = z
  .object({
    fullTrays: z.number().int().min(0).default(0),
    halfTrays: z.number().int().min(0).default(0),
    isBadTrays: z.boolean().default(false),
    issue: z.string().optional(),
    notes: z.string().max(500).optional(),
    photoUrls: z.array(z.string()).default([]),
  })
  .refine((d) => !d.isBadTrays || !!d.issue, {
    message: "issue is required when isBadTrays is true",
    path: ["issue"],
  });

// ── Helpers ───────────────────────────────────────────────────────────────────

function enforceAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// TEN-010: the operational-role gates (history view, completed-cycle edits)
// collapse onto the org role — any non-technician member (owner/admin) is
// privileged. Reads req.tenant.role (server-resolved) rather than the JWT
// claim.
function isPrivileged(role: "owner" | "admin" | "technician"): boolean {
  return role !== "technician";
}

function parseParamId(req: Request): number {
  const v = req.params["id"];
  return parseInt(Array.isArray(v) ? v[0] : v, 10);
}

function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  res: Response,
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({
      error: "Validation failed",
      details: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

type Profile = typeof growthProfilesTable.$inferSelect;
type Cycle = typeof cyclesTable.$inferSelect;

function formatCycle(cycle: Cycle, profile: Profile) {
  return {
    id: cycle.id,
    shortId: cycle.shortId,
    seedLotQrCodes: cycle.seedLotQrCodes ?? [],
    seedName: cycle.seedName,
    fullTrays: cycle.fullTrays,
    halfTrays: cycle.halfTrays,
    seedWeightTray: Number(cycle.seedWeightTray),
    growthProfileId: cycle.growthProfileId,
    growthProfileName: profile.name,
    germinationDays: profile.germinationDays,
    fertigationDays: profile.fertigationDays,
    seedingDate: cycle.seedingDate,
    status: cycle.status as "germination" | "fertigation" | "harvest" | "completed",
    trayPosition: cycle.trayPosition ?? null,
    germinationStartedAt: cycle.germinationStartedAt?.toISOString() ?? null,
    fertigationStartedAt: cycle.fertigationStartedAt?.toISOString() ?? null,
    harvestStartedAt: cycle.harvestStartedAt?.toISOString() ?? null,
    harvestedQty: cycle.harvestedQty ? Number(cycle.harvestedQty) : null,
    closedAt: cycle.closedAt?.toISOString() ?? null,
    createdBy: cycle.userId ?? null,
    createdAt: cycle.createdAt.toISOString(),
    daysOverdueFertigation:
      cycle.status === "germination"
        ? calcDaysOverdue(cycle.germinationStartedAt, profile.germinationDays)
        : null,
    daysOverdueHarvest:
      cycle.status === "fertigation" || cycle.status === "harvest"
        ? calcDaysOverdue(cycle.fertigationStartedAt, profile.fertigationDays)
        : null,
  };
}

// Task 11 Step 4: async because photo references are signed at the response
// boundary (signMediaReferences). Callers must `await Promise.all(...)` the
// mapping. A check with no photos calls signMediaReferences([]) which returns
// [] immediately without touching storage.
async function formatCheck(c: typeof manualChecksTable.$inferSelect) {
  return {
    id: c.id,
    cycleId: c.cycleId,
    fullTrays: c.fullTrays,
    halfTrays: c.halfTrays,
    isBadTrays: c.isBadTrays,
    issue: c.issue ?? null,
    notes: c.notes ?? null,
    photoUrls: await signMediaReferences(c.photoUrls ?? []),
    createdBy: c.userId ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/cycles", async (req, res) => {
  try {
    const status = (req.query.status as string) || "ongoing";

    if (status === "history" && !isPrivileged(req.tenant!.role)) {
      return res
        .status(403)
        .json({ error: "History access is restricted to admins" });
    }

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(
          growthProfilesTable,
          eq(cyclesTable.growthProfileId, growthProfilesTable.id),
        )
        .where(
          and(
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
            status === "history"
              ? eq(cyclesTable.status, "completed")
              : ne(cyclesTable.status, "completed"),
          ),
        )
        .orderBy(desc(cyclesTable.createdAt)),
    );

    return res.json(
      rows
        .filter((r) => r.profile !== null)
        .map((r) => formatCycle(r.cycle, r.profile!)),
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch cycles" });
  }
});

router.post("/cycles", enforceAuth, async (req, res) => {
  try {
    const body = validate(CreateCycleSchema, req.body, res);
    if (!body) return;

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.id, body.growthProfileId))
        .limit(1),
    );
    if (!profile) {
      return res.status(400).json({ error: "Growth profile not found" });
    }

    const auth = getAuth(req);
    let shortId = generateShortId();
    let cycle: typeof cyclesTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [cycle] = await withTenantScope(req.tenant!, (tx) =>
        tx
          .insert(cyclesTable)
          .values({
            shortId,
            seedLotQrCodes: body.seedLotQrCodes,
            seedName: body.seedName,
            fullTrays: body.fullTrays,
            halfTrays: body.halfTrays,
            seedWeightTray: String(body.seedWeightTray),
            growthProfileId: body.growthProfileId,
            seedingDate: body.seedingDate,
            status: "germination",
            trayPosition: body.trayPosition,
            germinationStartedAt: new Date(),
            userId: auth?.userId ?? null,
            facilityId: req.tenant!.facilityId,
          })
          .onConflictDoNothing({ target: [cyclesTable.shortId] })
          .returning(),
      );
      if (cycle) break;
      shortId = generateShortId();
    }

    if (!cycle) {
      return res.status(500).json({ error: "Failed to generate a unique cycle short ID" });
    }

    const hasSensorData =
      body.humidity !== undefined ||
      body.temperature !== undefined ||
      body.ph !== undefined ||
      body.waterLevel !== undefined ||
      body.nutrientMix !== undefined;

    if (hasSensorData) {
      const sensorUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (body.humidity !== undefined) sensorUpdate.humidityPct = body.humidity;
      if (body.temperature !== undefined) sensorUpdate.tempCelsius = body.temperature;
      if (body.ph !== undefined) sensorUpdate.acidityPh = body.ph;
      if (body.waterLevel !== undefined) sensorUpdate.waterLevelPct = body.waterLevel;
      if (body.nutrientMix !== undefined) sensorUpdate.nutrientMix = body.nutrientMix;

      // Unchanged (sensorStatusTable is out of scope — see Global Constraints):
      const [existing] = await db.select({ id: sensorStatusTable.id }).from(sensorStatusTable).limit(1);
      if (existing) {
        await db.update(sensorStatusTable).set(sensorUpdate).where(eq(sensorStatusTable.id, existing.id));
      } else {
        await db.insert(sensorStatusTable).values(sensorUpdate as typeof sensorStatusTable.$inferInsert);
      }
    }

    return res.status(201).json(formatCycle(cycle, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create cycle" });
  }
});

router.get("/cycles/:id", async (req, res) => {
  try {
    const id = parseParamId(req);

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(
          growthProfilesTable,
          eq(cyclesTable.growthProfileId, growthProfilesTable.id),
        )
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!rows.length || !rows[0].profile) {
      return res.status(404).json({ error: "Cycle not found" });
    }

    if (rows[0].cycle.status === "completed" && !isPrivileged(req.tenant!.role)) {
      return res
        .status(403)
        .json({ error: "Access to completed cycle details is restricted to admins" });
    }

    const checks = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(manualChecksTable)
        .where(eq(manualChecksTable.cycleId, id))
        .orderBy(desc(manualChecksTable.createdAt)),
    );

    return res.json({
      ...formatCycle(rows[0].cycle, rows[0].profile!),
      manualChecks: await Promise.all(checks.map(formatCheck)),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch cycle" });
  }
});

router.post("/cycles/:id/fertigation", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(FertigationSchema, req.body, res);
    if (body === null) return;

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });
    if (cycle.status !== "germination")
      return res.status(400).json({ error: "Cycle is not in germination status" });

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.id, cycle.growthProfileId))
        .limit(1),
    );

    if (profile && cycle.germinationStartedAt) {
      const dueMs = cycle.germinationStartedAt.getTime() + profile.germinationDays * 86_400_000;
      if (Date.now() < dueMs) {
        const daysRemaining = Math.ceil((dueMs - Date.now()) / 86_400_000);
        return res.status(423).json({
          error: "Germination period not yet complete.",
          daysRemaining,
        });
      }
    }

    // Compares against this cycle's own stored array, not a fresh seed_lots lookup — no cross-facility ambiguity here (see seedLots.ts for the query that did need rescoping).
    const qrCodes = cycle.seedLotQrCodes ?? [];
    if (body.seedLotQrCode && qrCodes.length > 0 && !qrCodes.includes(body.seedLotQrCode)) {
      return res
        .status(400)
        .json({ error: "QR code does not match any seed lot for this cycle" });
    }

    const [updated] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(cyclesTable)
        .set({ status: "fertigation", fertigationStartedAt: new Date() })
        .where(
          and(
            eq(cyclesTable.id, id),
            eq(cyclesTable.status, "germination"),
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning(),
    );

    if (!updated) {
      return res
        .status(409)
        .json({ error: "Cycle is no longer in germination status (concurrent transition)" });
    }

    const hasSensorData =
      body.humidity !== undefined ||
      body.temperature !== undefined ||
      body.ph !== undefined ||
      body.waterLevel !== undefined ||
      body.nutrientMix !== undefined;

    if (hasSensorData) {
      const sensorUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (body.humidity !== undefined) sensorUpdate.humidityPct = body.humidity;
      if (body.temperature !== undefined) sensorUpdate.tempCelsius = body.temperature;
      if (body.ph !== undefined) sensorUpdate.acidityPh = body.ph;
      if (body.waterLevel !== undefined) sensorUpdate.waterLevelPct = body.waterLevel;
      if (body.nutrientMix !== undefined) sensorUpdate.nutrientMix = body.nutrientMix;

      const [existing] = await db.select({ id: sensorStatusTable.id }).from(sensorStatusTable).limit(1);
      if (existing) {
        await db.update(sensorStatusTable).set(sensorUpdate).where(eq(sensorStatusTable.id, existing.id));
      } else {
        await db.insert(sensorStatusTable).values(sensorUpdate as typeof sensorStatusTable.$inferInsert);
      }
    }


    return res.json(formatCycle(updated, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to move cycle to fertigation" });
  }
});

// Step 1 of harvest: mark as "harvest" in progress
router.post("/cycles/:id/harvest", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(StartHarvestSchema, req.body, res);
    if (body === null) return;

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });
    if (cycle.status !== "fertigation")
      return res.status(400).json({ error: "Cycle is not in fertigation status" });

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.id, cycle.growthProfileId))
        .limit(1),
    );

    if (profile && cycle.fertigationStartedAt) {
      const dueMs = cycle.fertigationStartedAt.getTime() + profile.fertigationDays * 86_400_000;
      if (Date.now() < dueMs) {
        const daysRemaining = Math.ceil((dueMs - Date.now()) / 86_400_000);
        return res.status(423).json({
          error: "Fertigation period not yet complete.",
          daysRemaining,
        });
      }
    }

    const [updated] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(cyclesTable)
        .set({
          status: "harvest",
          harvestStartedAt: new Date(),
          trayPosition: body.trayQrCode ?? cycle.trayPosition,
        })
        .where(
          and(
            eq(cyclesTable.id, id),
            eq(cyclesTable.status, "fertigation"),
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning(),
    );

    if (!updated) {
      return res
        .status(409)
        .json({ error: "Cycle is no longer in fertigation status (concurrent transition)" });
    }

    return res.json(formatCycle(updated, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to start harvest" });
  }
});

// Step 2 of harvest: record final quantities and close the cycle
router.post("/cycles/:id/complete-harvest", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(CompleteHarvestSchema, req.body, res);
    if (body === null) return;

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });
    if (cycle.status !== "harvest")
      return res.status(400).json({ error: "Cycle is not in harvest status" });

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.id, cycle.growthProfileId))
        .limit(1),
    );

    const auth = getAuth(req);

    const updated = await withTenantScope(req.tenant!, async (tx) => {
      const [row] = await tx
        .update(cyclesTable)
        .set({
          status: "completed",
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          harvestedQty: String(body.harvestedQty),
          closedAt: new Date(),
          trayPosition: body.trayQrCode ?? cycle.trayPosition,
        })
        .where(
          and(
            eq(cyclesTable.id, id),
            eq(cyclesTable.status, "harvest"),
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning();

      if (!row) return null; // concurrent transition — another request beat us (I2)

      if (body.isBadTrays) {
        await tx.insert(manualChecksTable).values({
          cycleId: id,
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          isBadTrays: true,
          issue: body.issue ?? null,
          notes: "Flagged at harvest",
          photoUrls: [],
          userId: auth?.userId ?? null,
        });

        const affectedTrays = (body.fullTrays ?? cycle.fullTrays) + (body.halfTrays ?? cycle.halfTrays) * 0.5;
        const expectedYieldPerTrayKg = Number(profile?.expectedYieldPerTrayKg ?? 0);
        const lossEstimate = affectedTrays * expectedYieldPerTrayKg * 1000;
        const severity = affectedTrays >= 5 ? "high" : affectedTrays >= 2 ? "medium" : "low";

        await tx.insert(badTrayEntriesTable).values({
          cycleId: id,
          issue: body.issue ?? null,
          severity,
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          photoUrls: [],
          lossEstimate: String(lossEstimate),
          userId: auth?.userId ?? null,
        });
      }
      return row;
    });

    if (!updated) {
      return res
        .status(409)
        .json({ error: "Cycle is no longer in harvest status (concurrent transition)" });
    }

    return res.json(formatCycle(updated, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to complete harvest" });
  }
});

router.get("/cycles/:id/manual-checks", async (req, res) => {
  try {
    const id = parseParamId(req);

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ status: cyclesTable.status })
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!cycle) {
      return res.status(404).json({ error: "Cycle not found" });
    }

    if (cycle.status === "completed" && !isPrivileged(req.tenant!.role)) {
      return res
        .status(403)
        .json({ error: "Access to completed cycle audit log is restricted to admins" });
    }

    const checks = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(manualChecksTable)
        .where(eq(manualChecksTable.cycleId, id))
        .orderBy(desc(manualChecksTable.createdAt)),
    );
    return res.json(await Promise.all(checks.map(formatCheck)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch manual checks" });
  }
});

router.post("/cycles/:id/manual-checks", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(ManualCheckSchema, req.body, res);
    if (body === null) return;

    const auth = getAuth(req);

    const result = await withTenantScope(req.tenant!, async (tx) => {
      const [cycleRow] = await tx
        .select({ id: cyclesTable.id, growthProfileId: cyclesTable.growthProfileId })
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)));

      if (!cycleRow) return null;

      const [check] = await tx
        .insert(manualChecksTable)
        .values({
          cycleId: id,
          fullTrays: body.fullTrays,
          halfTrays: body.halfTrays,
          isBadTrays: body.isBadTrays,
          issue: body.issue ?? null,
          notes: body.notes ?? null,
          photoUrls: body.photoUrls ?? [],
          userId: auth?.userId ?? null,
        })
        .returning();

      if (body.isBadTrays) {
        // Wastage-aware loss estimate (Phase 7): grounded in this cycle's own
        // growth profile expected yield, not a flat per-tray guess — affected
        // trays' share of what this specific crop was actually expected to
        // produce. expectedYieldPerTrayKg is kg; grams to match
        // totalYieldThisWeek's unit.
        let expectedYieldPerTrayKg = 0;
        if (cycleRow.growthProfileId) {
          const [profile] = await tx
            .select({ expectedYieldPerTrayKg: growthProfilesTable.expectedYieldPerTrayKg })
            .from(growthProfilesTable)
            .where(eq(growthProfilesTable.id, cycleRow.growthProfileId));
          expectedYieldPerTrayKg = Number(profile?.expectedYieldPerTrayKg ?? 0);
        }

        const affectedTrays = (body.fullTrays ?? 0) + (body.halfTrays ?? 0) * 0.5;
        const lossEstimate = affectedTrays * expectedYieldPerTrayKg * 1000;
        const severity = affectedTrays >= 5 ? "high" : affectedTrays >= 2 ? "medium" : "low";

        await tx.insert(badTrayEntriesTable).values({
          cycleId: id,
          issue: body.issue ?? null,
          severity,
          fullTrays: body.fullTrays,
          halfTrays: body.halfTrays,
          photoUrls: body.photoUrls ?? [],
          lossEstimate: String(lossEstimate),
          userId: auth?.userId ?? null,
        });
      }

      return check;
    });

    if (!result) return res.status(404).json({ error: "Cycle not found" });
    return res.status(201).json(await formatCheck(result));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create manual check" });
  }
});

export default router;
