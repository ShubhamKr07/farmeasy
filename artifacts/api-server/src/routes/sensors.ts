import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withTenantScope, sensorsTable } from "@workspace/db";

const router = Router();

function formatSensor(s: typeof sensorsTable.$inferSelect) {
  return {
    id: s.id,
    channelId: s.channelId ?? null,
    rackId: s.rackId ?? null,
    roomId: s.roomId ?? null,
    facilityWide: s.facilityWide,
    sensorAccountId: s.sensorAccountId ?? null,
    type: s.type,
    label: s.label,
    unit: s.unit ?? null,
    lastValue: s.lastValue === null ? null : Number(s.lastValue),
    lastReadAt: s.lastReadAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/sensors", async (req: Request, res: Response) => {
  try {
    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(sensorsTable).where(eq(sensorsTable.facilityId, req.tenant!.facilityId)),
    );
    return res.json(rows.map(formatSensor));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch sensors" });
  }
});

router.post("/sensors", async (req: Request, res: Response) => {
  try {
    const { channelId, rackId, type, label, unit } = req.body;
    if (!type || !label) {
      return res.status(400).json({ error: "type and label are required" });
    }
    if (!channelId && !rackId) {
      return res.status(400).json({ error: "channelId or rackId is required" });
    }
    const [s] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(sensorsTable)
        .values({
          channelId: channelId ?? null,
          rackId: rackId ?? null,
          type,
          label,
          unit: unit ?? null,
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );
    return res.status(201).json(formatSensor(s));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create sensor" });
  }
});

const BulkCreateSensorsSchema = z
  .object({
    label: z.string().min(1),
    types: z.array(z.enum(["temp", "ph", "water", "humidity", "ec"])).min(1),
    channelIds: z.array(z.number().int()).optional(),
    rackIds: z.array(z.number().int()).optional(),
    roomId: z.number().int().optional(),
    facilityWide: z.boolean().optional(),
    sensorAccountId: z.number().int().nullable().optional(),
  })
  .refine(
    (d) =>
      (d.channelIds && d.channelIds.length > 0) ||
      (d.rackIds && d.rackIds.length > 0) ||
      d.roomId !== undefined ||
      d.facilityWide === true,
    { message: "At least one of channelIds, rackIds, roomId, or facilityWide is required" },
  );

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// Device-model decision (Global Constraints): one sensors row per (measure ×
// placement-target) combination, all sharing `label` — a "device" with N
// measures on M channels becomes N*M rows, grouped back together
// client-side by shared label.
router.post("/sensors/bulk", async (req: Request, res: Response) => {
  try {
    const body = validate(BulkCreateSensorsSchema, req.body, res);
    if (!body) return;

    // Placement targets: one row's worth of channelId/rackId per target.
    // Exactly one of these three branches applies, enforced by the refine
    // above (at least one placement mechanism is present) — channel and
    // rack multi-select are mutually exclusive in the wizard UI (Task 10's
    // PlacementLadder picks ONE rung), so this file doesn't need to handle
    // "both channelIds AND rackIds provided" as a real case, but if both
    // arrives anyway, channelIds takes precedence (documented below).
    const placements: Array<{ channelId: number | null; rackId: number | null }> =
      body.channelIds && body.channelIds.length > 0
        ? body.channelIds.map((channelId) => ({ channelId, rackId: null }))
        : body.rackIds && body.rackIds.length > 0
          ? body.rackIds.map((rackId) => ({ channelId: null, rackId }))
          : [{ channelId: null, rackId: null }]; // room-level or facility-wide: one row per type, no per-channel/rack split

    const rows = body.types.flatMap((type) =>
      placements.map((placement) => ({
        channelId: placement.channelId,
        rackId: placement.rackId,
        roomId: body.roomId ?? null,
        facilityWide: body.facilityWide ?? false,
        sensorAccountId: body.sensorAccountId ?? null,
        type,
        label: body.label,
        facilityId: req.tenant!.facilityId,
      })),
    );

    const created = await withTenantScope(req.tenant!, (tx) =>
      tx.insert(sensorsTable).values(rows).returning(),
    );
    return res.status(201).json({ created: created.map(formatSensor) });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to bulk-create sensors" });
  }
});

export default router;
