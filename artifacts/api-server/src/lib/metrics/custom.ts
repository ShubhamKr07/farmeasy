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

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function ovYieldExpectedVsActual(facilityId: number, timezone: string) {
  const q = substitutePlaceholders(`
    SELECT gp.crop_id::text AS label,
           COALESCE(SUM(gp.expected_yield_per_tray_kg * (cycles.full_trays + cycles.half_trays * 0.5)), 0) AS expected,
           COALESCE(SUM(cycles.harvested_qty), 0) AS actual
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE ${andWhere(softDelete("cycles"), "cycles.status='completed'")}
    GROUP BY gp.crop_id
    ORDER BY actual DESC
  `, facilityId, timezone);
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? "(unknown)"),
    expected: num(r.expected),
    actual: num(r.actual),
  }));
}

async function ovCapUtilByRoom() {
  const q = `
    SELECT rm.name::text AS label,
           COUNT(*) FILTER (WHERE cycles.status IS NOT NULL AND cycles.status <> 'completed') AS running,
           COUNT(*) AS total
    FROM channels ch
    JOIN rooms rm ON rm.id = ch.room_id
    LEFT JOIN racks rk ON rk.channel_id = ch.id
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND cycles.deleted_at IS NULL
    GROUP BY rm.name
    ORDER BY rm.name
  `;
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.running) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovCapTrayMix() {
  const q = `
    SELECT COALESCE(SUM(full_trays), 0) AS full_trays, COALESCE(SUM(half_trays), 0) AS half_trays
    FROM cycles WHERE status <> 'completed' AND deleted_at IS NULL
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  return [
    { label: "Full", value: num(row.full_trays) },
    { label: "Half", value: num(row.half_trays) },
  ];
}

async function ovCyclesCompletionRate() {
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE cycles.status = 'completed') AS completed,
      COUNT(*) AS cohort
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE cycles.deleted_at IS NULL
      AND cycles.seeding_date >= current_date - interval '90 days'
      AND (cycles.status = 'completed'
           OR cycles.seeding_date + ((gp.germination_days + gp.fertigation_days) || ' days')::interval <= now())
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const cohort = num(row.cohort);
  return { value: cohort > 0 ? num(row.completed) / cohort : 0 };
}

async function ovBadRate() {
  const q = `
    SELECT
      (SELECT COUNT(*) FROM bad_tray_entries WHERE created_at >= now() - interval '30 days') AS bad,
      (SELECT COALESCE(SUM(full_trays + half_trays), 0) FROM cycles
        WHERE seeding_date >= current_date - interval '30 days' AND deleted_at IS NULL) AS seeded
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const seeded = num(row.seeded);
  return { value: seeded > 0 ? num(row.bad) / seeded : 0 };
}

async function shRevGrowth() {
  const q = `
    SELECT
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE deleted_at IS NULL AND shipping_date >= current_date - interval '30 days') AS current,
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE deleted_at IS NULL AND shipping_date >= current_date - interval '60 days'
          AND shipping_date < current_date - interval '30 days') AS prior
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const prior = num(row.prior);
  return { value: prior !== 0 ? (num(row.current) - prior) / prior : 0 };
}

async function shEconWasteRate() {
  const q = `
    SELECT
      COALESCE(SUM(cycles.harvested_qty), 0) AS harvested,
      COALESCE(SUM(sold.total), 0) AS sold
    FROM cycles
    LEFT JOIN (
      SELECT cycle_id, SUM(yield_sold_kg) AS total
      FROM shipments WHERE deleted_at IS NULL AND cycle_id IS NOT NULL
      GROUP BY cycle_id
    ) sold ON sold.cycle_id = cycles.id
    WHERE cycles.status = 'completed' AND cycles.deleted_at IS NULL
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const harvested = num(row.harvested);
  return { value: harvested > 0 ? (harvested - num(row.sold)) / harvested : 0 };
}

async function invMovTurnover() {
  const q = `
    SELECT
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'), 0) AS consumed,
      COALESCE((SELECT AVG(current_qty) FROM inventory_items WHERE deleted_at IS NULL), 0) AS avg_stock
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const avgStock = num(row.avg_stock);
  return { value: avgStock > 0 ? num(row.consumed) / avgStock : 0 };
}

async function ovCapRackOccupancy() {
  const q = `
    SELECT rk.label::text AS label,
           COUNT(*) FILTER (WHERE cycles.id IS NOT NULL) AS occupied,
           COUNT(*) AS total
    FROM racks rk
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND cycles.deleted_at IS NULL AND cycles.status <> 'completed'
    GROUP BY rk.id, rk.label
    ORDER BY rk.label
  `;
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.occupied) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovSensorUptime() {
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE last_read_at >= now() - interval '2 minutes') AS fresh,
      COUNT(*) AS total
    FROM sensors
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const total = num(row.total);
  return { value: total > 0 ? Math.round((num(row.fresh) / total) * 1000) / 10 : 0 };
}

async function invMovDaysRemaining() {
  const q = `
    SELECT
      COALESCE((SELECT SUM(current_qty) FROM inventory_items WHERE deleted_at IS NULL), 0) AS current_qty,
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'), 0) / 30.0 AS daily_rate
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const dailyRate = num(row.daily_rate);
  return { value: dailyRate > 0 ? num(row.current_qty) / dailyRate : 0 };
}

export const CUSTOM_QUERIES: Record<string, (facilityId: number, timezone: string) => Promise<unknown>> = {
  "ov.yield.expectedVsActual": ovYieldExpectedVsActual,
  "ov.cap.utilByRoom": () => ovCapUtilByRoom(),
  "ov.cap.trayMix": () => ovCapTrayMix(),
  "ov.cycles.completionRate": () => ovCyclesCompletionRate(),
  "ov.bad.rate": () => ovBadRate(),
  "sh.rev.growth": () => shRevGrowth(),
  "sh.econ.wasteRate": () => shEconWasteRate(),
  "inv.mov.turnover": () => invMovTurnover(),
  "inv.mov.daysRemaining": () => invMovDaysRemaining(),
  "ov.cap.rackOccupancy": () => ovCapRackOccupancy(),
  "ov.sensor.uptime": () => ovSensorUptime(),
};
