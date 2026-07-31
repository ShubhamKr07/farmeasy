import { describe, test, before } from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Golden-fixture tests for the /api/metrics query templates.
 *
 * Gated on TEST_DATABASE_URL (a dedicated Neon branch or local Postgres —
 * never prod). The suite TRUNCATES + seeds deterministic rows, then asserts
 * each template's output against hand-computed expected values
 * (fixtures/expected.ts).
 *
 *   TEST_DATABASE_URL=postgresql://... node --import tsx/esm --test \
 *     artifacts/api-server/src/tests/metrics/metrics.test.ts
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const REQUIRE_TEST_DB = process.env.REQUIRE_TEST_DATABASE === "true";

if (REQUIRE_TEST_DB && !TEST_DB) {
  throw new Error(
    "TEST_DATABASE_URL is required when REQUIRE_TEST_DATABASE=true",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));

function approxEqual(actual: number, expected: number, eps = 1e-6): void {
  ok(Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`);
}

describe("metrics templates (golden fixture)", { skip: !TEST_DB }, () => {
  // Lazily imported in `before` so DATABASE_URL can be set to the test DB first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let templates: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let expected: any;

  before(async () => {
    if (!TEST_DB) return;
    process.env.DATABASE_URL = TEST_DB;
    db = (await import("@workspace/db")).db;
    sql = (await import("drizzle-orm")).sql;
    templates = await import("../../lib/metrics/templates");
    expected = (await import("./fixtures/expected")).expected;
    const seed = readFileSync(path.resolve(here, "fixtures", "seed.sql"), "utf8");
    await db.execute(sql.raw(seed));
  });

  test("scalarAgg — ov.yield.alltime", async () => {
    const r = await templates.scalarAgg({
      table: "cycles", measure: "harvested_qty",
      where: "status='completed' AND deleted_at IS NULL",
    });
    approxEqual(r.value, expected.yieldAlltime);
  });

  test("groupBy — ov.cycles.byStatus", async () => {
    const r = await templates.groupBy({
      table: "cycles", measure: "*", dim: "status", where: "deleted_at IS NULL",
    });
    // Order-agnostic compare (templates order by value desc; compare as sets).
    const norm = (xs: { label: string; value: number }[]) =>
      xs.map((x) => `${x.label}=${x.value}`).sort().join(",");
    deepStrictEqual(norm(r), norm([...expected.cyclesByStatus]));
  });

  test("timeBucket — ov.yield.byMonth (all)", async () => {
    const r = await templates.timeBucket({
      table: "cycles", measure: "harvested_qty", dateCol: "closed_at", bucket: "month",
      where: "status='completed' AND deleted_at IS NULL",
    }, "all");
    // Last 3 months from now; only assert the seeded month has the expected sum
    // and the series is non-empty (the empty-month count depends on today's date).
    ok(r.length >= 1, "timeBucket returned no points");
    const jun = r.find((p: { label: string; value: number }) => p.label === "2026-06");
    ok(jun, "expected a 2026-06 bucket");
    approxEqual(jun!.value, 3000);
  });

  test("groupBy — ov.alerts.bySeverity (current only)", async () => {
    const r = await templates.groupBy({
      table: "alerts", measure: "*", dim: "severity", where: "status='current'",
    });
    const norm = (xs: { label: string; value: number }[]) =>
      xs.map((x) => `${x.label}=${x.value}`).sort().join(",");
    deepStrictEqual(norm(r), norm([...expected.alertsBySeverity]));
  });

  test("groupBy — ov.tasks.byStatus", async () => {
    const r = await templates.groupBy({ table: "tasks", measure: "*", dim: "status" });
    const norm = (xs: { label: string; value: number }[]) =>
      xs.map((x) => `${x.label}=${x.value}`).sort().join(",");
    deepStrictEqual(norm(r), norm([...expected.tasksByStatus]));
  });

  test("groupBy — ov.bad.bySeverity", async () => {
    const r = await templates.groupBy({ table: "bad_tray_entries", measure: "*", dim: "severity" });
    const norm = (xs: { label: string; value: number }[]) =>
      xs.map((x) => `${x.label}=${x.value}`).sort().join(",");
    deepStrictEqual(norm(r), norm([...expected.badBySeverity]));
  });

  test("ratio — sh.econ.pricePerKg", async () => {
    const r = (await templates.ratio({
      numTable: "shipments", numMeasure: "revenue_usd",
      denTable: "shipments", denMeasure: "yield_sold_kg",
      numWhere: "deleted_at IS NULL AND revenue_usd IS NOT NULL",
      denWhere: "deleted_at IS NULL AND yield_sold_kg > 0",
    })) as { value: number };
    approxEqual(r.value, expected.pricePerKg);
  });

  test("groupBy — inv.mov.byReason", async () => {
    const r = await templates.groupBy({ table: "stock_movements", measure: "*", dim: "reason" });
    const norm = (xs: { label: string; value: number }[]) =>
      xs.map((x) => `${x.label}=${x.value}`).sort().join(",");
    deepStrictEqual(norm(r), norm([...expected.movementsByReason]));
  });
});
