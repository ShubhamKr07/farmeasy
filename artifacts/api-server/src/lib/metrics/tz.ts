import { sql } from "drizzle-orm";

/**
 * §1.5 global-rule helpers for metric query templates. Applied centrally so
 * individual templates can't forget them.
 *
 * Columns are zoneless `timestamp` (not `timestamptz`) storing facility-local
 * time (dictionary rule 1, zoneless note). Bucketing therefore uses plain
 * `date_trunc('<unit>', col)` (calendar-buckets in the column's native
 * facility-local representation). `now()` is timestamptz (UTC), so window
 * bounds convert it to facility-local via `now() AT TIME ZONE :tz` before
 * subtracting intervals — keeping zoneless-to-zoneless comparisons consistent.
 */

export const FACILITY_TIMEZONE = process.env.FACILITY_TIMEZONE ?? "America/New_York";

/** Cutover date for bad-trays source (dictionary rule 4). Phase 2a migration 0003. */
export const BAD_TRAYS_CUTOVER_DATE = process.env.BAD_TRAYS_CUTOVER_DATE ?? "2026-07-03";

/** Tables that carry a `deleted_at` soft-delete column (rule 2). */
const SOFT_DELETE_TABLES = new Set(["cycles", "shipments", "inventory_items"]);

/** "table.deleted_at IS NULL" if the table soft-deletes, else "TRUE". */
export function softDelete(table: string): string {
  return SOFT_DELETE_TABLES.has(table) ? `${table}.deleted_at IS NULL` : "TRUE";
}

/**
 * Tables the metrics registry declares as `p.table` that have their OWN
 * facility_id column, scoped directly.
 */
const DIRECT_FACILITY_TABLES = new Set(["cycles", "alerts", "tasks", "shipments", "seed_lots"]);

/**
 * Tables with no facility_id of their own — scoped via a subquery through
 * their FK to a directly-scoped parent. Confirmed against
 * lib/db/src/schema/index.ts's actual FK references (not the registry's own
 * bespoke `join` clauses, which serve a different purpose — dimension/label
 * joins, not scoping — and must not be relied on for this).
 */
const CHILD_FACILITY_SUBQUERIES: Record<string, string> = {
  stock_movements: "inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = :facilityId)",
  bad_tray_entries: "cycle_id IN (SELECT id FROM cycles WHERE facility_id = :facilityId)",
  sensor_readings: "sensor_id IN (SELECT id FROM sensors WHERE facility_id = :facilityId)",
  cycle_seed_lots: "cycle_id IN (SELECT id FROM cycles WHERE facility_id = :facilityId)",
};

/**
 * Facility-scope WHERE fragment for a metrics registry table. "" for tables
 * with no tenant column at all (crops — a genuinely global shared catalog,
 * confirmed via schema: no facility_id/organization_id, name globally
 * unique). Threaded through :facilityId the same way :cutover/:weekStart/
 * :monthStart already are (substitutePlaceholders below).
 */
export function facilityScope(table: string): string {
  if (DIRECT_FACILITY_TABLES.has(table)) return `${table}.facility_id = :facilityId`;
  if (table in CHILD_FACILITY_SUBQUERIES) return CHILD_FACILITY_SUBQUERIES[table]!;
  return "";
}

/** date_trunc('<unit>', <colExpr>) — facility-local calendar bucket (rule 1). */
export function dateTrunc(unit: string, colExpr: string): string {
  return `date_trunc('${unit}', ${colExpr})`;
}

/** Facility-local "now" as a zoneless timestamp, for window bounds. */
export function facilityNow(timezone: string): string {
  return `now() AT TIME ZONE '${timezone}'`;
}

/**
 * WHERE fragment restricting `<colExpr>` to the last `days` days (facility-local).
 * Returns "" for unbounded (all-time).
 */
export function rangeWindow(colExpr: string, range: string | undefined, timezone: string): string {
  const days = rangeToDays(range);
  if (days == null) return "";
  return `${colExpr} >= (${facilityNow(timezone)}) - interval '${days} days'`;
}

export function rangeToDays(range: string | undefined): number | null {
  switch (range) {
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
    default: return null; // "all" / "custom" (custom not yet wired) → unbounded
  }
}

/** Combined WHERE: join fragments with AND, wrapping in parentheses. */
export function andWhere(...fragments: (string | undefined)[]): string {
  const parts = fragments.filter((f): f is string => !!f && f.length > 0);
  if (parts.length === 0) return "TRUE";
  return parts.map((p) => `(${p})`).join(" AND ");
}

/** Execute a raw SQL string via drizzle. */
export function execRaw(query: string) {
  return sql.raw(query);
}

/**
 * Replace registry placeholder tokens with concrete SQL. Lets `where` fragments
 * reference named boundaries without the template re-deriving them.
 *   :cutover    -> 'YYYY-MM-DD' (BAD_TRAYS_CUTOVER_DATE)
 *   :weekStart  -> facility now - 7 days
 *   :monthStart -> facility now - 30 days
 */
export function substitutePlaceholders(q: string, facilityId: number, timezone: string): string {
  return q
    .replace(/:cutover/g, `'${BAD_TRAYS_CUTOVER_DATE}'`)
    .replace(/:weekStart/g, `(${facilityNow(timezone)} - interval '7 days')`)
    .replace(/:monthStart/g, `(${facilityNow(timezone)} - interval '30 days')`)
    .replace(/:facilityId/g, String(Number(facilityId)));
}

/** COUNT(*) for "*", else SUM(<measure>). Ratio/timeBucket row counts vs sums. */
export function sumOrCount(measure: string): string {
  return measure === "*" ? "COUNT(*)" : `SUM(${measure})`;
}
