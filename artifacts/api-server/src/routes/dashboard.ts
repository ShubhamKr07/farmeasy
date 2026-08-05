import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { eq, ne, count, sql } from "drizzle-orm";
import { withTenantScope, type TenantContext } from "@workspace/db";
import {
  cyclesTable,
  growthProfilesTable,
  manualChecksTable,
  seedLotsTable,
  alertsTable,
  sensorsTable,
  channelsTable,
  badTrayEntriesTable,
} from "@workspace/db";
import { calcDaysOverdue, seedingWeight } from "../lib/utils";

const router = Router();

type UserRole = "technician" | "supervisor" | "quality_lead" | "facility_lead";

function enforceAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * The full GET /dashboard computation, extracted so other callers (the
 * recommender's ops-question grounding in routes/recommend.ts) can reuse
 * the exact same numbers instead of re-deriving them — one compute path
 * per number, enforced across features, not just within this route.
 *
 * Wrapped in withTenantScope: every table this function reads (cycles,
 * growth_profiles, manual_checks, seed_lots, alerts, sensors,
 * bad_tray_entries, channels) has an RLS policy requiring app.facility_id/
 * app.org_id to be set. Without this wrapper, the query previously ran on a
 * connection that never set it, so under a real non-BYPASSRLS role every
 * number here silently computed as if the whole system were empty (found
 * during MT-M1's final review, same failure class as the metrics dispatch
 * fix — see routes/metrics.ts).
 */
export async function computeDashboardSnapshot(tenant: TenantContext) {
  return withTenantScope(tenant, async (tx) => {
  const runningRows = await tx
      .select({ cycle: cyclesTable, profile: growthProfilesTable })
      .from(cyclesTable)
      .leftJoin(
        growthProfilesTable,
        eq(cyclesTable.growthProfileId, growthProfilesTable.id),
      )
      .where(ne(cyclesTable.status, "completed"));

    const actionRequired: {
      cycleId: number;
      cycleShortId: string;
      seedName: string;
      trayPosition: string | null;
      type: "fertigation" | "harvest";
      daysOverdue: number;
    }[] = [];

    for (const { cycle, profile } of runningRows) {
      if (!profile) continue;
      const now = Date.now();

      if (cycle.status === "germination" && cycle.germinationStartedAt) {
        const dueMs =
          cycle.germinationStartedAt.getTime() +
          profile.germinationDays * 864e5;
        if (now > dueMs) {
          actionRequired.push({
            cycleId: cycle.id,
            cycleShortId: cycle.shortId,
            seedName: cycle.seedName,
            trayPosition: cycle.trayPosition,
            type: "fertigation",
            daysOverdue: Math.floor((now - dueMs) / 864e5),
          });
        }
      } else if (cycle.status === "fertigation" && cycle.fertigationStartedAt) {
        const dueMs =
          cycle.fertigationStartedAt.getTime() +
          profile.fertigationDays * 864e5;
        if (now > dueMs) {
          actionRequired.push({
            cycleId: cycle.id,
            cycleShortId: cycle.shortId,
            seedName: cycle.seedName,
            trayPosition: cycle.trayPosition,
            type: "harvest",
            daysOverdue: Math.floor((now - dueMs) / 864e5),
          });
        }
      }
    }

    // Note: alert auto-creation for overdue cycles moved to a scheduled job
    // (lib/overdue-scanner) — GET /dashboard is now read-only (R6).

    const completedRows = await tx
      .select({
        harvestedQty: cyclesTable.harvestedQty,
        closedAt: cyclesTable.closedAt,
      })
      .from(cyclesTable)
      .where(eq(cyclesTable.status, "completed"));

    const badTrayChecks = await tx
      .select({
        fullTrays: manualChecksTable.fullTrays,
        halfTrays: manualChecksTable.halfTrays,
        seedWeightTray: cyclesTable.seedWeightTray,
        createdAt: manualChecksTable.createdAt,
      })
      .from(manualChecksTable)
      .innerJoin(cyclesTable, eq(manualChecksTable.cycleId, cyclesTable.id))
      .where(eq(manualChecksTable.isBadTrays, true));

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let totalYieldThisWeek = 0;
    let totalYieldThisMonth = 0;
    for (const c of completedRows) {
      if (!c.harvestedQty || !c.closedAt) continue;
      const qty = Number(c.harvestedQty);
      if (c.closedAt >= weekStart) totalYieldThisWeek += qty;
      if (c.closedAt >= monthStart) totalYieldThisMonth += qty;
    }

    // Total Waste (Phase 7): SUM(bad_tray_entries.lossEstimate), same weekly
    // window as totalYieldThisWeek — wastage-aware estimate grounded in each
    // cycle's own expected yield (see POST /cycles/:id/manual-checks and
    // /complete-harvest), not a flat per-tray guess.
    const wasteRows = await tx
      .select({ lossEstimate: badTrayEntriesTable.lossEstimate, createdAt: badTrayEntriesTable.createdAt })
      .from(badTrayEntriesTable);
    let totalWasteThisWeek = 0;
    for (const w of wasteRows) {
      if (w.createdAt >= weekStart) totalWasteThisWeek += Number(w.lossEstimate ?? 0);
    }

    // Time-series via SQL generate_series + date_trunc + SUM (R5: replaces
    // JS-over-full-tables bucketing). Fragments are hardcoded safe SQL.
    async function bucketSeries(
      bucket: "day" | "week",
      count: number,
      valueExpr: string,
      joinExpr: string,
      dateColExpr: string,
      onExtra = "",
    ): Promise<{ label: string; value: number }[]> {
      const back = `${count - 1} ${bucket}s`;
      const interval = bucket === "day" ? "1 day" : "1 week";
      const labelExpr = bucket === "day" ? `to_char(gs.d, 'Dy')` : `NULL`;
      const res = await tx.execute(sql`
        SELECT ${sql.raw(labelExpr)} AS label, COALESCE(SUM(${sql.raw(valueExpr)}), 0) AS value
        FROM generate_series(
          date_trunc(${sql.raw(`'${bucket}'`)}, now() - interval ${sql.raw(`'${back}'`)}),
          date_trunc(${sql.raw(`'${bucket}'`)}, now()),
          interval ${sql.raw(`'${interval}'`)}
        ) AS gs(d)
        LEFT JOIN ${sql.raw(joinExpr)}
          ON date_trunc(${sql.raw(`'${bucket}'`)}, ${sql.raw(dateColExpr)}) = gs.d ${sql.raw(onExtra)}
        GROUP BY gs.d
        ORDER BY gs.d
      `);
      const rows = res.rows as { label: string | null; value: string | number }[];
      return rows.map((r, i) => ({
        label: bucket === "day" ? (r.label ?? "") : `W${i + 1}`,
        value: Number(r.value),
      }));
    }

    const seedWtExpr = "c.seed_weight_tray * (c.full_trays + c.half_trays * 0.5)";
    const badSeedWtExpr = "c.seed_weight_tray * (mc.full_trays + mc.half_trays * 0.5)";
    const badJoin = "manual_checks mc LEFT JOIN cycles c ON c.id = mc.cycle_id";

    const [yieldByDay, seedingByDay, badTrayByDay, yieldByWeek, seedingByWeek, badTrayByWeek] =
      await Promise.all([
        bucketSeries("day", 7, "c.harvested_qty", "cycles c", "c.closed_at", "AND c.status = 'completed'"),
        bucketSeries("day", 7, seedWtExpr, "cycles c", "c.created_at"),
        bucketSeries("day", 7, badSeedWtExpr, badJoin, "mc.created_at", "AND mc.is_bad_trays"),
        bucketSeries("week", 4, "c.harvested_qty", "cycles c", "c.closed_at", "AND c.status = 'completed'"),
        bucketSeries("week", 4, seedWtExpr, "cycles c", "c.created_at"),
        bucketSeries("week", 4, badSeedWtExpr, badJoin, "mc.created_at", "AND mc.is_bad_trays"),
      ]);

    // Active seed lots (currently being grown)
    const activeSeedLotsRows = await tx
      .select({
        id: seedLotsTable.id,
        seedName: seedLotsTable.seedName,
        qrCode: seedLotsTable.qrCode,
        currentlyGrown: seedLotsTable.currentlyGrown,
      })
      .from(seedLotsTable)
      .where(eq(seedLotsTable.currentlyGrown, true));
    const activeSeedLots = activeSeedLotsRows.length;

    // Active crop types (distinct seed names in running cycles)
    const cropTypes = new Set(runningRows.map((r) => r.cycle.seedName));
    const activeCropTypes = cropTypes.size;

    // Total bad trays
    const totalBadTrays = badTrayChecks.reduce(
      (sum, c) => sum + c.fullTrays + Math.ceil(c.halfTrays * 0.5),
      0,
    );
    const badTraysCount = badTrayChecks.filter((c) => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return c.createdAt >= d;
    }).length;

    // Sensor status (Phase 7): sourced from the real per-channel-linked
    // sensors/sensor_readings tables (facility layout's monitoringApi*
    // config is what a sensor is attached via channelId), not the legacy
    // flat sensor_status singleton row that was never wired to any actual
    // sensor. A metric errors out (isError: true) only if no sensor of that
    // type exists or has ever reported a reading — no fabricated fallback
    // (G11), a metric with zero readings is surfaced as an error, not
    // silently null. A metric that HAS reported before keeps showing its
    // last known real value even once stale (staleness is a real, not
    // fabricated, number) — sensorsOnline/sensorsTotal below is still the
    // live freshness signal for anyone who needs it.
    const STALE_MS = 15 * 60 * 1000; // 15 min — used for sensorsOnline count only, not per-metric error
    const allSensors = await tx.select().from(sensorsTable);
    const now2 = Date.now();

    function metricFor(type: "temp" | "ph" | "water" | "humidity") {
      const candidates = allSensors.filter((sn) => sn.type === type && sn.lastReadAt);
      const latest = candidates.sort(
        (a, b) => (b.lastReadAt as Date).getTime() - (a.lastReadAt as Date).getTime(),
      )[0];
      return {
        value: latest ? Number(latest.lastValue ?? 0) : null,
        isError: !latest,
      };
    }

    const tempMetric = metricFor("temp");
    const phMetric = metricFor("ph");
    const humidityMetric = metricFor("humidity");
    const waterMetric = metricFor("water");
    const sensorsOnline = allSensors.filter(
      (sn) => sn.lastReadAt && now2 - sn.lastReadAt.getTime() <= STALE_MS,
    ).length;

    const sensorStatus = {
      sensorsOnline,
      sensorsTotal: allSensors.length,
      acidityPh: phMetric.value,
      acidityPhError: phMetric.isError,
      waterLevelPct: waterMetric.value,
      waterLevelPctError: waterMetric.isError,
      tempCelsius: tempMetric.value,
      tempCelsiusError: tempMetric.isError,
      humidityPct: humidityMetric.value,
      humidityPctError: humidityMetric.isError,
    };

    // Current alerts count
    const currentAlerts = await tx
      .select({ id: alertsTable.id, severity: alertsTable.severity })
      .from(alertsTable)
      .where(eq(alertsTable.status, "current"));

    // Channel utilization denominator: real channel count, not a hardcoded const (R9).
    const channelCountRows = await tx.select({ c: count() }).from(channelsTable);
    const totalChannels = Number(channelCountRows[0]?.c ?? 0);

    return {
      channelUtilization: totalChannels > 0 ? runningRows.length / totalChannels : 0,
      totalRunningCycles: runningRows.length,
      totalChannels,
      totalYieldThisWeek,
      totalYieldThisMonth,
      totalWasteThisWeek,
      activeSeedLots,
      activeSeedLotDetails: activeSeedLotsRows.map((s) => ({
        id: s.id,
        seedName: s.seedName,
        qrCode: s.qrCode,
      })),
      badTraysCount,
      activeCropTypes,
      totalBadTrays,
      yieldByDay,
      yieldByWeek,
      seedingByDay,
      seedingByWeek,
      badTrayByDay,
      badTrayByWeek,
      sensorStatus,
      currentAlertsCount: currentAlerts.length,
      criticalAlertsCount: currentAlerts.filter((a) => a.severity === "critical").length,
      actionRequired: actionRequired.sort((a, b) => b.daysOverdue - a.daysOverdue),
    };
  });
}

router.get("/dashboard", async (req: Request, res: Response) => {
  try {
    const snapshot = await computeDashboardSnapshot(req.tenant!);
    return res.json(snapshot);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch dashboard" });
  }
});

export default router;
