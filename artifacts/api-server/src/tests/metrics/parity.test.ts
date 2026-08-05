import { describe, test, before, after } from "node:test";
import { ok } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getAdminDb } from "../helpers/testDatabase";

// See metrics.test.ts's identical constant for why this cleanup exists --
// same fixture, same collision risk with later test files' auto-generated
// inserts once this fixture's hardcoded id=1 rows are left behind.
const FIXTURE_TABLES =
  "sensor_readings, sensors, stock_movements, bad_tray_entries, tasks, " +
  "alerts, shipments, inventory_items, cycle_seed_lots, cycles, " +
  "seed_lots, growth_profiles, crops, channels, rooms, facilities, organizations";

/**
 * Tier-A → Tier-B parity: the same number whether computed client-side (JS
 * over the list payload) or server-side (SQL template). Catches the drift the
 * design warns about (dictionary §1.5, design §3 "one compute path per number").
 *
 * Gated on TEST_DATABASE_URL. Run with the metrics fixture suite.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const REQUIRE_TEST_DB = process.env.REQUIRE_TEST_DATABASE === "true";

if (REQUIRE_TEST_DB && !TEST_DB) {
  throw new Error(
    "TEST_DATABASE_URL is required when REQUIRE_TEST_DATABASE=true",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));

describe("tier-A vs tier-B parity (golden fixture)", { skip: !TEST_DB }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let templates: any;

  before(async () => {
    if (!TEST_DB) return;
    process.env.DATABASE_URL = TEST_DB;
    db = (await import("@workspace/db")).db;
    sql = (await import("drizzle-orm")).sql;
    templates = await import("../../lib/metrics/templates");
    const seed = readFileSync(path.resolve(here, "fixtures", "seed.sql"), "utf8");
    await (getAdminDb() ?? db).execute(sql.raw(seed));
  });

  after(async () => {
    if (!TEST_DB) return;
    await (getAdminDb() ?? db).execute(sql.raw(`TRUNCATE ${FIXTURE_TABLES} RESTART IDENTITY CASCADE`));
  });

  // Matches fixtures/seed.sql's seeded facility (id 1, timezone "UTC").
  const FACILITY_ID = 1;
  const TIMEZONE = "UTC";

  test("sh.rev.total: client SUM === SQL scalarAgg", async () => {
    // node-postgres returns Postgres `numeric` columns as strings (to avoid
    // float precision loss), not numbers -- despite the TS annotation below.
    // Without Number(), `a + r.revenue_usd` string-concatenates instead of
    // summing once `a` picks up a non-zero starting value.
    //
    // Reads via the admin connection: this raw client-side query recomputes
    // the expected sum directly from the table, independent of the app's own
    // scoped SQL path under test -- under farmsmart_app (no app.facility_id
    // set here), 00007's tenant-isolation RLS policy would otherwise filter
    // this SELECT down to zero rows.
    const rows = await (getAdminDb() ?? db).execute(sql`SELECT revenue_usd FROM shipments WHERE deleted_at IS NULL`);
    const clientSum = (rows.rows as { revenue_usd: string | number | null }[])
      .reduce((a, r) => a + Number(r.revenue_usd ?? 0), 0);
    const sqlRes = await templates.scalarAgg({
      table: "shipments", measure: "revenue_usd", where: "deleted_at IS NULL",
    }, FACILITY_ID, TIMEZONE);
    ok(Math.abs(clientSum - sqlRes.value) < 1e-6, `revenue mismatch: client ${clientSum} vs sql ${sqlRes.value}`);
  });

  test("sh.sold.total: client SUM === SQL scalarAgg", async () => {
    // Same numeric-as-string coercion and admin-connection reasoning as
    // sh.rev.total above.
    const rows = await (getAdminDb() ?? db).execute(sql`SELECT yield_sold_kg FROM shipments WHERE deleted_at IS NULL`);
    const clientSum = (rows.rows as { yield_sold_kg: string | number | null }[])
      .reduce((a, r) => a + Number(r.yield_sold_kg ?? 0), 0);
    const sqlRes = await templates.scalarAgg({
      table: "shipments", measure: "yield_sold_kg", where: "deleted_at IS NULL",
    }, FACILITY_ID, TIMEZONE);
    ok(Math.abs(clientSum - sqlRes.value) < 1e-6, `yield-sold mismatch: client ${clientSum} vs sql ${sqlRes.value}`);
  });
});
