import { Router, type Request, type Response } from "express";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { withTenantScope } from "@workspace/db";
import { sensorReadingsTable, sensorsTable } from "@workspace/db";

const router = Router();

function formatReading(r: {
  id: number;
  sensorId: number;
  metric: string;
  value: string;
  readAt: Date;
}) {
  return {
    id: r.id,
    sensorId: r.sensorId,
    metric: r.metric,
    value: Number(r.value),
    readAt: r.readAt.toISOString(),
  };
}

// TEN-014 hotfix: previously this queried sensor_readings directly with no
// facility/org WHERE at all -- any authenticated user in ANY org could omit
// sensorId and get up to 1000 recent readings across every org/facility, or
// pass another org's sensorId directly and get it back (every sensor carries
// a real, NOT NULL facility_id). sensor_readings' own RLS (00021) is a
// current_user backend backstop only, not GUC-scoped (see that migration's
// doc comment -- facility_id was deliberately NOT denormalized onto this
// table), so the app layer is the ONLY place this can be enforced: join to
// sensors and filter by req.tenant.facilityId, mirroring sensors.ts's own
// GET /sensors. A caller-supplied sensorId that doesn't belong to the
// tenant's facility now matches nothing in the join (empty list), never
// another org's rows -- same "filter, don't 404" convention every other list
// endpoint in this file's sibling routes already uses (e.g. GET /alerts).
router.get("/sensor-readings", async (req: Request, res: Response) => {
  try {
    const sensorId = req.query["sensorId"]
      ? parseInt(req.query["sensorId"] as string, 10)
      : undefined;
    const from = req.query["from"] ? new Date(req.query["from"] as string) : undefined;
    const to = req.query["to"] ? new Date(req.query["to"] as string) : undefined;

    const conds = [eq(sensorsTable.facilityId, req.tenant!.facilityId)];
    if (sensorId) conds.push(eq(sensorReadingsTable.sensorId, sensorId));
    if (from) conds.push(gte(sensorReadingsTable.readAt, from));
    if (to) conds.push(lte(sensorReadingsTable.readAt, to));

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({
          id: sensorReadingsTable.id,
          sensorId: sensorReadingsTable.sensorId,
          metric: sensorReadingsTable.metric,
          value: sensorReadingsTable.value,
          readAt: sensorReadingsTable.readAt,
        })
        .from(sensorReadingsTable)
        .innerJoin(sensorsTable, eq(sensorReadingsTable.sensorId, sensorsTable.id))
        .where(and(...conds))
        .orderBy(desc(sensorReadingsTable.readAt))
        .limit(1000),
    );

    return res.json(rows.map(formatReading));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch sensor readings" });
  }
});

// TEN-014 hotfix (write side): previously this inserted a reading against a
// caller-supplied sensorId with NO ownership check, then updated
// sensors.lastValue/lastReadAt for that same id in the same tx -- any
// authenticated member of ANY org could POST a reading tagged to another
// org's sensor (serial PKs are enumerable) and overwrite that org's live
// sensor state, corrupting its dashboard/monitoring/alerting. Mirror
// sensors.ts's trust model: never trust a client-supplied id against another
// tenant's rows -- look the sensor up scoped to req.tenant.facilityId first,
// and only insert/update if it's actually this tenant's sensor. Unlike the
// GET route's "filter, don't 404" convention (a list endpoint silently
// narrowing results), this is a single-resource write against a supplied id
// that doesn't belong to the tenant -- treat it like sensors.ts would treat
// posting to a foreign resource: reject with 404, not a silent partial
// success.
router.post("/sensor-readings", async (req: Request, res: Response) => {
  try {
    const { sensorId, metric, value } = req.body;
    if (!sensorId || !metric || value === undefined) {
      return res.status(400).json({ error: "sensorId, metric, and value are required" });
    }

    const reading = await withTenantScope(req.tenant!, async (tx) => {
      const [sensor] = await tx
        .select({ id: sensorsTable.id })
        .from(sensorsTable)
        .where(
          and(eq(sensorsTable.id, sensorId), eq(sensorsTable.facilityId, req.tenant!.facilityId)),
        );
      if (!sensor) return null;

      const [r] = await tx
        .insert(sensorReadingsTable)
        .values({ sensorId, metric, value: String(value) })
        .returning();
      await tx
        .update(sensorsTable)
        .set({ lastValue: String(value), lastReadAt: new Date() })
        .where(eq(sensorsTable.id, sensorId));
      return r;
    });

    if (!reading) {
      return res.status(404).json({ error: "Sensor not found" });
    }

    return res.status(201).json(formatReading(reading));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to record sensor reading" });
  }
});

export default router;
