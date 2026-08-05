import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { substitutePlaceholders, softDelete, andWhere } from "./tz";

/**
 * Hand-written queries for metrics that don't fit the 5 generic templates
 * (multi-CTE, window functions, correlated subqueries). Keyed by metric id —
 * dispatched from routes/metrics.ts via `template: "custom", templateParams:
 * { key: "<metric id>" }`. Each function owns its full SQL; still applies
 * §1.5 rules (soft-delete, facility-local bucketing) via the tz.ts helpers.
 */

type Row = Record<string, unknown>;

// The transaction client withTenantScope (lib/db/src/scope.ts) hands its
// callback -- structurally compatible with `db` for the one method these
// functions actually call (a PgTransaction lacks db's own `$client` property,
// so `typeof db` itself is too narrow here; both shapes satisfy .execute()).
// Every function here takes it as an optional trailing param and runs its
// query via `(tx ?? db)`: routes/metrics.ts always passes the real tx (so
// these queries run on the SAME connection that set app.org_id/
// app.facility_id, which 00007's RLS policies require to admit any row);
// metrics.test.ts/parity.test.ts's golden-fixture tests call these directly
// without a tx and get the module-level `db` unchanged, exactly as before.
type DbClient = Pick<typeof db, "execute">;

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function ovYieldExpectedVsActual(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT gp.crop_id::text AS label,
           COALESCE(SUM(gp.expected_yield_per_tray_kg * (cycles.full_trays + cycles.half_trays * 0.5)), 0) AS expected,
           COALESCE(SUM(cycles.harvested_qty), 0) AS actual
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE ${andWhere(softDelete("cycles"), "cycles.status='completed'", "cycles.facility_id = :facilityId")}
    GROUP BY gp.crop_id
    ORDER BY actual DESC
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? "(unknown)"),
    expected: num(r.expected),
    actual: num(r.actual),
  }));
}

async function ovCapUtilByRoom(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT rm.name::text AS label,
           COUNT(*) FILTER (WHERE cycles.status IS NOT NULL AND cycles.status <> 'completed') AS running,
           COUNT(*) AS total
    FROM channels ch
    JOIN rooms rm ON rm.id = ch.room_id
    LEFT JOIN racks rk ON rk.channel_id = ch.id
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND ${softDelete("cycles")}
    WHERE rm.facility_id = :facilityId
    GROUP BY rm.name
    ORDER BY rm.name
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.running) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovCapTrayMix(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT COALESCE(SUM(full_trays), 0) AS full_trays, COALESCE(SUM(half_trays), 0) AS half_trays
    FROM cycles WHERE ${andWhere(softDelete("cycles"), "status <> 'completed'", "facility_id = :facilityId")}
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  return [
    { label: "Full", value: num(row.full_trays) },
    { label: "Half", value: num(row.half_trays) },
  ];
}

async function ovCyclesCompletionRate(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      COUNT(*) FILTER (WHERE cycles.status = 'completed') AS completed,
      COUNT(*) AS cohort
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE ${andWhere(softDelete("cycles"), "facility_id = :facilityId",
      "seeding_date >= current_date - interval '90 days'",
      "(cycles.status = 'completed' OR cycles.seeding_date + ((gp.germination_days + gp.fertigation_days) || ' days')::interval <= now())")}
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const cohort = num(row.cohort);
  return { value: cohort > 0 ? num(row.completed) / cohort : 0 };
}

async function ovBadRate(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      (SELECT COUNT(*) FROM bad_tray_entries
        WHERE created_at >= now() - interval '30 days'
          AND cycle_id IN (SELECT id FROM cycles WHERE facility_id = :facilityId)) AS bad,
      (SELECT COALESCE(SUM(full_trays + half_trays), 0) FROM cycles
        WHERE seeding_date >= current_date - interval '30 days' AND ${softDelete("cycles")}
          AND facility_id = :facilityId) AS seeded
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const seeded = num(row.seeded);
  return { value: seeded > 0 ? num(row.bad) / seeded : 0 };
}

async function shRevGrowth(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE ${andWhere(softDelete("shipments"), "facility_id = :facilityId")}
          AND shipping_date >= current_date - interval '30 days') AS current,
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE ${andWhere(softDelete("shipments"), "facility_id = :facilityId")}
          AND shipping_date >= current_date - interval '60 days'
          AND shipping_date < current_date - interval '30 days') AS prior
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const prior = num(row.prior);
  return { value: prior !== 0 ? (num(row.current) - prior) / prior : 0 };
}

async function shEconWasteRate(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      COALESCE(SUM(cycles.harvested_qty), 0) AS harvested,
      COALESCE(SUM(sold.total), 0) AS sold
    FROM cycles
    LEFT JOIN (
      SELECT cycle_id, SUM(yield_sold_kg) AS total
      FROM shipments WHERE ${andWhere(softDelete("shipments"), "facility_id = :facilityId")} AND cycle_id IS NOT NULL
      GROUP BY cycle_id
    ) sold ON sold.cycle_id = cycles.id
    WHERE ${andWhere(softDelete("cycles"), "cycles.status = 'completed'", "cycles.facility_id = :facilityId")}
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const harvested = num(row.harvested);
  return { value: harvested > 0 ? (harvested - num(row.sold)) / harvested : 0 };
}

async function invMovTurnover(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'
                   AND inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = :facilityId)), 0) AS consumed,
      COALESCE((SELECT AVG(current_qty) FROM inventory_items
                 WHERE ${andWhere(softDelete("inventory_items"), "facility_id = :facilityId")}), 0) AS avg_stock
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const avgStock = num(row.avg_stock);
  return { value: avgStock > 0 ? num(row.consumed) / avgStock : 0 };
}

async function ovCapRackOccupancy(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT rk.label::text AS label,
           COUNT(*) FILTER (WHERE cycles.id IS NOT NULL) AS occupied,
           COUNT(*) AS total
    FROM racks rk
    JOIN channels ch ON ch.id = rk.channel_id
    JOIN rooms rm ON rm.id = ch.room_id
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND ${softDelete("cycles")} AND cycles.status <> 'completed'
    WHERE rm.facility_id = :facilityId
    GROUP BY rk.id, rk.label
    ORDER BY rk.label
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.occupied) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovSensorUptime(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      COUNT(*) FILTER (WHERE last_read_at >= now() - interval '2 minutes') AS fresh,
      COUNT(*) AS total
    FROM sensors
    WHERE facility_id = :facilityId
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const total = num(row.total);
  return { value: total > 0 ? Math.round((num(row.fresh) / total) * 1000) / 10 : 0 };
}

async function invMovDaysRemaining(facilityId: number, timezone: string, tx?: DbClient) {
  const q = substitutePlaceholders(`
    SELECT
      COALESCE((SELECT SUM(current_qty) FROM inventory_items
                 WHERE ${andWhere(softDelete("inventory_items"), "facility_id = :facilityId")}), 0) AS current_qty,
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'
                   AND inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = :facilityId)), 0) / 30.0 AS daily_rate
  `, facilityId, timezone);
  const res = await (tx ?? db).execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const dailyRate = num(row.daily_rate);
  return { value: dailyRate > 0 ? num(row.current_qty) / dailyRate : 0 };
}

export const CUSTOM_QUERIES: Record<string, (facilityId: number, timezone: string, tx?: DbClient) => Promise<unknown>> = {
  "ov.yield.expectedVsActual": ovYieldExpectedVsActual,
  "ov.cap.utilByRoom": ovCapUtilByRoom,
  "ov.cap.trayMix": ovCapTrayMix,
  "ov.cycles.completionRate": ovCyclesCompletionRate,
  "ov.bad.rate": ovBadRate,
  "sh.rev.growth": shRevGrowth,
  "sh.econ.wasteRate": shEconWasteRate,
  "inv.mov.turnover": invMovTurnover,
  "inv.mov.daysRemaining": invMovDaysRemaining,
  "ov.cap.rackOccupancy": ovCapRackOccupancy,
  "ov.sensor.uptime": ovSensorUptime,
};
