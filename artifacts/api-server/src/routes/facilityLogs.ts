import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { z } from "zod";
import { db } from "@workspace/db";
import { facilityLogsTable } from "@workspace/db";

const router = Router();

// ── Per-type Zod schemas (Alpha App Phase 4.3) ──────────────────────────────
// One shared facility_logs table + jsonb `data` column — per-type schemas
// here give the same field-level type safety a per-type table would, without
// a migration every time a field changes.

const MaintenanceDataSchema = z.object({
  areaItem: z.string().min(1).max(200),
  frequency: z.string().min(1).max(50),
  year: z.number().int().min(2000).max(2100),
  monthsCompleted: z.array(z.enum([
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ])).default([]),
});

const WasteDataSchema = z.object({
  wasteType: z.string().min(1).max(100),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(20),
  disposalMethod: z.string().min(1).max(200),
  photoUrls: z.array(z.string()).max(4).default([]),
});

const EnvCheckDataSchema = z.object({
  zone: z.string().min(1).max(200),
  tempC: z.number().optional(),
  humidityPct: z.number().min(0).max(100).optional(),
  ph: z.number().min(0).max(14).optional(),
});

const CleaningDataSchema = z.object({
  area: z.string().min(1).max(200),
  cleaningType: z.string().min(1).max(100),
  productUsed: z.string().max(200).optional(),
  photoUrls: z.array(z.string()).max(4).default([]),
});

const ReceivingDataSchema = z.object({
  itemType: z.enum(["seed_lot", "nutrient", "supply"]),
  itemName: z.string().min(1).max(200),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(20),
  supplier: z.string().max(200).optional(),
  photoUrls: z.array(z.string()).max(4).default([]),
});

const VisitorDataSchema = z.object({
  visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  timeIn: z.string().min(1).max(20),
  timeOut: z.string().max(20).optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  organization: z.string().max(200).optional(),
  contactInfo: z.string().max(200).optional(),
  facilityContact: z.string().min(1).max(200),
});

const LOG_TYPE_SCHEMAS = {
  maintenance: MaintenanceDataSchema,
  waste: WasteDataSchema,
  env_check: EnvCheckDataSchema,
  cleaning: CleaningDataSchema,
  receiving: ReceivingDataSchema,
  visitor: VisitorDataSchema,
} as const;

type LogType = keyof typeof LOG_TYPE_SCHEMAS;

const CreateFacilityLogSchema = z.object({
  logType: z.enum(["maintenance", "waste", "env_check", "cleaning", "receiving", "visitor"]),
  data: z.record(z.string(), z.unknown()),
  notes: z.string().max(1000).optional(),
});

/**
 * POST /api/facility-logs { logType, data, notes? }
 *
 * Create-only — no list/history endpoints in this phase (explicitly out of
 * scope, see docs/alpha-app.md). `data` is validated against the matching
 * per-type schema above before insert; every submission is still kept in
 * the shared table, so a browse view later is additive, not a migration.
 */
router.post("/facility-logs", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const envelope = CreateFacilityLogSchema.safeParse(req.body);
  if (!envelope.success) {
    return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
  }

  const { logType, data, notes } = envelope.data;
  const dataSchema = LOG_TYPE_SCHEMAS[logType as LogType];
  const parsedData = dataSchema.safeParse(data);
  if (!parsedData.success) {
    return res.status(400).json({ error: "Validation failed", details: parsedData.error.flatten() });
  }

  try {
    const [log] = await db
      .insert(facilityLogsTable)
      .values({
        logType,
        userId: userId,
        data: parsedData.data,
        notes: notes ?? null,
      })
      .returning();

    return res.status(201).json({
      id: log.id,
      logType: log.logType,
      data: log.data,
      notes: log.notes ?? null,
      createdAt: log.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility log" });
  }
});

export default router;
