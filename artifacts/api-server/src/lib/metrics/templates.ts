import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type {
  ScalarAggParams,
  GroupByParams,
  TimeBucketParams,
  RatioParams,
  TableParams,
  CustomParams,
  QuickbooksParams,
  TemplateName,
} from "@workspace/metrics";
import { CUSTOM_QUERIES } from "./custom";
import { runQuickbooksQuery } from "../accounting/quickbooks-reports";
import {
  dateTrunc,
  facilityNow,
  rangeToDays,
  softDelete,
  facilityScope,
  andWhere,
  substitutePlaceholders,
  sumOrCount,
} from "./tz";

/**
 * Query-template builders. Each composes a SQL string from registry-authored
 * params (trusted) + a validated `range`, then executes via drizzle. §1.5
 * global rules (soft-delete, facility-local bucketing) applied centrally.
 *
 * Returns plain JSON-shaped data the dashboard can render directly.
 */

type Row = Record<string, unknown>;

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function aggExpr(measure: string, agg?: string): string {
  const a = (agg ?? (measure === "*" ? "count" : "sum")).toLowerCase();
  if (a === "count") return `COUNT(${measure === "*" ? "*" : measure})`;
  return `${a.toUpperCase()}(${measure})`;
}

export async function scalarAgg(p: ScalarAggParams, facilityId: number, timezone: string, range?: string): Promise<{ value: number }> {
  void timezone;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where, rangeWindowFor(p.table, p, range));
  const join = p.join ? `JOIN ${p.join}` : "";
  const q = substitutePlaceholders(
    `SELECT ${aggExpr(p.measure, p.agg)} AS value FROM ${p.table} ${join} WHERE ${where}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return { value: num((res.rows[0] as Row)?.value) };
}

export async function groupBy(p: GroupByParams, facilityId: number, timezone: string, range?: string): Promise<{ label: string; value: number }[]> {
  void timezone;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where, rangeWindowFor(p.table, p, range));
  const order = p.order ? `ORDER BY value ${p.order.toUpperCase()}` : "ORDER BY value DESC";
  const limit = p.limit ? `LIMIT ${p.limit}` : "";
  const join = p.join ? `JOIN ${p.join}` : "";
  const q = substitutePlaceholders(
    `SELECT COALESCE(${p.dim}::text, '(unknown)') AS label, ${aggExpr(p.measure, p.agg)} AS value
     FROM ${p.table} ${join} WHERE ${where} GROUP BY ${p.dim} ${order} ${limit}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({ label: String(r.label ?? ""), value: num(r.value) }));
}

export async function timeBucket(p: TimeBucketParams, facilityId: number, timezone: string, range?: string): Promise<{ label: string; value: number }[]> {
  void timezone;
  const { unit, count } = bucketRange(p.bucket, range);
  const start = `${dateTrunc(unit, facilityNow())} - interval '${count - 1} ${unit}s'`;
  const end = dateTrunc(unit, facilityNow());
  const intervalStep = `interval '1 ${unit}'`;
  const join = p.sensorType
    ? `${p.table} t JOIN sensors s ON s.id = t.sensor_id AND s.type = '${p.sensorType}'`
    : p.table;
  const dateCol = p.sensorType ? `t.${p.dateCol}` : `${p.table}.${p.dateCol}`;
  const measureExpr = p.measure === "*"
    ? "*"
    : p.sensorType ? `t.${p.measure}` : `${p.table}.${p.measure}`;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where);
  const q = substitutePlaceholders(
    `SELECT to_char(gs.d, '${labelFmt(unit)}') AS label,
            COALESCE(${sumOrCount(measureExpr)}, 0) AS value
     FROM generate_series(${start}, ${end}, ${intervalStep}) AS gs(d)
     LEFT JOIN ${join} ON ${dateTrunc(unit, dateCol)} = gs.d ${p.where ? `AND ${p.where}` : ""}
     GROUP BY gs.d ORDER BY gs.d`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({ label: String(r.label ?? ""), value: num(r.value) }));
}

export async function ratio(p: RatioParams, facilityId: number, timezone: string, range?: string): Promise<{ value: number } | { label: string; value: number }[]> {
  void timezone; void range;
  if (p.dim) {
    const where = andWhere(softDelete(p.numTable), facilityScope(p.numTable), p.numWhere);
    const q = substitutePlaceholders(
      `SELECT COALESCE(${p.dim}::text, '(unknown)') AS label,
              COALESCE(${sumOrCount(p.numMeasure)}, 0) AS num,
              COALESCE(${sumOrCount(p.denMeasure)}, 0) AS den
       FROM ${p.numTable} WHERE ${where} GROUP BY ${p.dim} ORDER BY num DESC`,
      facilityId,
    );
    const res = await db.execute(sql.raw(q));
    return (res.rows as Row[]).map((r) => ({
      label: String(r.label ?? ""),
      value: num(r.den) !== 0 ? num(r.num) / num(r.den) : 0,
    }));
  }
  const numW = andWhere(softDelete(p.numTable), facilityScope(p.numTable), p.numWhere);
  const denW = andWhere(softDelete(p.denTable), facilityScope(p.denTable), p.denWhere);
  const q = substitutePlaceholders(
    `SELECT COALESCE((SELECT ${sumOrCount(p.numMeasure)} FROM ${p.numTable} WHERE ${numW}), 0) AS num,
            COALESCE((SELECT ${sumOrCount(p.denMeasure)} FROM ${p.denTable} WHERE ${denW}), 0) AS den`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const den = num(row.den);
  return { value: den !== 0 ? num(row.num) / den : 0 };
}

export async function tableTemplate(p: TableParams, facilityId: number, timezone: string, range?: string): Promise<Row[]> {
  void timezone; void range;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where);
  const order = p.order ? `ORDER BY 1 ${p.order.toUpperCase()}` : "";
  const limit = p.limit ? `LIMIT ${p.limit}` : "";
  const q = substitutePlaceholders(
    `SELECT ${p.cols} FROM ${p.table} ${p.join ? `JOIN ${p.join}` : ""} WHERE ${where} ${order} ${limit}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return res.rows as Row[];
}

export async function customTemplate(p: CustomParams, facilityId: number, timezone: string, range?: string): Promise<unknown> {
  void facilityId; void timezone; void range;
  const fn = CUSTOM_QUERIES[p.key];
  if (!fn) throw new Error(`no custom query registered for key: ${p.key}`);
  return fn();
}

export async function quickbooksTemplate(
  p: QuickbooksParams,
  facilityId: number,
  timezone: string,
  range?: string,
  userId?: string,
  organizationId?: number,
): Promise<unknown> {
  void facilityId; void timezone; void range;
  if (!userId) throw new Error("quickbooks template requires an authenticated user");
  if (organizationId === undefined) throw new Error("quickbooks template requires an organization id");
  return runQuickbooksQuery(p.key, userId, organizationId);
}

// ── helpers ───────────────────────────────────────────────────────────────

function rangeWindowFor(table: string, p: { where?: string }, range?: string): string {
  void table; void p;
  // Generic range window needs a date column per table; templates that support
  // range declare it in their params (timeBucket via dateCol). scalarAgg/groupBy
  // range filtering is metric-specific and handled via the `where` fragment in
  // the registry (which can reference :weekStart etc. when wired). For now,
  // scalarAgg/groupBy are all-time unless their `where` encodes a window.
  return rangeToDays(range) == null ? "" : "";
}

function bucketRange(bucket: TimeBucketParams["bucket"], range?: string): { unit: string; count: number } {
  const days = rangeToDays(range);
  if (bucket === "hour") return { unit: "hour", count: 24 };
  if (bucket === "day") return { unit: "day", count: days ?? 7 };
  if (bucket === "week") return { unit: "week", count: Math.ceil((days ?? 30) / 7) || 4 };
  return { unit: "month", count: Math.ceil((days ?? 90) / 30) || 3 };
}

function labelFmt(unit: string): string {
  if (unit === "day") return "MM-DD";
  if (unit === "week") return "IYYY-IW";
  if (unit === "month") return "YYYY-MM";
  return "HH24:MI";
}

export const TEMPLATES: Record<TemplateName, (p: any, facilityId: number, timezone: string, range?: string, userId?: string, organizationId?: number) => Promise<unknown>> = {
  scalarAgg,
  groupBy,
  timeBucket,
  ratio,
  table: tableTemplate,
  custom: customTemplate,
  quickbooks: quickbooksTemplate,
};
