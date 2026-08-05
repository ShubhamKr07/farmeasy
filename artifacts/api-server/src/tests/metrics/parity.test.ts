import { describe, test, before } from "node:test";
import { ok } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getAdminDb } from "../helpers/testDatabase";

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

  test("sh.rev.total: client SUM === SQL scalarAgg", async () => {
    // node-postgres returns Postgres `numeric` columns as strings (to avoid
    // float precision loss), not numbers -- despite the TS annotation below.
    // Without Number(), `a + r.revenue_usd` string-concatenates instead of
    // summing once `a` picks up a non-zero starting value.
    const rows = await db.execute(sql`SELECT revenue_usd FROM shipments WHERE deleted_at IS NULL`);
    const clientSum = (rows.rows as { revenue_usd: string | number | null }[])
      .reduce((a, r) => a + Number(r.revenue_usd ?? 0), 0);
    const sqlRes = await templates.scalarAgg({
      table: "shipments", measure: "revenue_usd", where: "deleted_at IS NULL",
    });
    ok(Math.abs(clientSum - sqlRes.value) < 1e-6, `revenue mismatch: client ${clientSum} vs sql ${sqlRes.value}`);
  });

  test("sh.sold.total: client SUM === SQL scalarAgg", async () => {
    // Same numeric-as-string coercion as sh.rev.total above.
    const rows = await db.execute(sql`SELECT yield_sold_kg FROM shipments WHERE deleted_at IS NULL`);
    const clientSum = (rows.rows as { yield_sold_kg: string | number | null }[])
      .reduce((a, r) => a + Number(r.yield_sold_kg ?? 0), 0);
    const sqlRes = await templates.scalarAgg({
      table: "shipments", measure: "yield_sold_kg", where: "deleted_at IS NULL",
    });
    ok(Math.abs(clientSum - sqlRes.value) < 1e-6, `yield-sold mismatch: client ${clientSum} vs sql ${sqlRes.value}`);
  });
});
