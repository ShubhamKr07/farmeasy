// scripts/ci/check-metric-definitions.test.mjs
//
// Self-test for scripts/ci/check-metric-definitions.mjs (HLP-001/002, Task 7).
// Discovered by the CI node-tests job's `find ... -name '*.self-test.mjs'` OR
// run directly as `node scripts/ci/check-metric-definitions.test.mjs`.
//
// Pure-synthetic: no DB, no network. Exercises the parser against
// positive/negative samples and asserts the live registries + catalog are in
// sync (the same diff the CLI enforces). If a registry gains a kpi/stat
// metric without a catalog entry, this test fails here rather than letting a
// silent "definition unavailable" tooltip ship.
//
// Run via: `node scripts/ci/check-metric-definitions.test.mjs`
//   exits 0 if all pass, non-zero if any fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRegistry,
  parseCatalogIds,
  computeMissing,
  REQUIRED_IDS,
  EXEMPT_IDS,
} from "./check-metric-definitions.mjs";

test("parseRegistry: extracts id + render from a metric line", () => {
  const src = `export const M = [
  { id: "ov.yield.week", tab: "overview", render: "kpi", source: "dashboard" },
  { id: "acct.foo", render: "kpi", source: "metrics" },
  { id: "ov.chart.bar", render: "area" },
];`;
  const out = parseRegistry(src);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: "ov.yield.week", render: "kpi" });
  assert.deepEqual(out[2], { id: "ov.chart.bar", render: "area" });
});

test("parseRegistry: ignores object literals without id or render", () => {
  const src = `const X = { foo: "bar", baz: 1 };
const Y = { id: "no.render" };`;
  assert.equal(parseRegistry(src).length, 0);
});

test("parseCatalogIds: extracts ov/acct ids from catalog keys", () => {
  const src = `export const C = {
  "ov.yield.week": { id: "ov.yield.week", term: "..." },
  "acct.cashBalance": { id: "acct.cashBalance" },
  // "ov.comment.only": not a real key
};`;
  const ids = parseCatalogIds(src);
  assert.ok(ids.has("ov.yield.week"));
  assert.ok(ids.has("acct.cashBalance"));
  assert.ok(!ids.has("ov.comment.only"));
});

test("computeMissing: returns missing ids for synthetic registries/catalog", () => {
  // We can't easily inject synthetic sources into computeMissing (it reads
  // fixed paths), but we CAN assert the parser+catalog combinators by hand:
  const registrySrc = `{ id: "ov.test.kpi", render: "kpi" }
{ id: "ov.test.area", render: "area" }`;
  const parsed = parseRegistry(registrySrc);
  const required = parsed
    .filter((m) => m.render === "kpi" || m.render === "stat")
    .map((m) => m.id)
    .filter((id) => !EXEMPT_IDS.has(id));
  const catalogIds = parseCatalogIds('"ov.test.kpi": { }');
  const missing = required.filter((id) => !catalogIds.has(id));
  assert.deepEqual(missing, []);
  // And a missing case:
  const catalogEmpty = new Set();
  const missing2 = required.filter((id) => !catalogEmpty.has(id));
  assert.deepEqual(missing2, ["ov.test.kpi"]);
});

test("LIVE: every kpi/stat metric from both registries has a catalog entry", () => {
  const { missing } = computeMissing();
  assert.deepEqual(missing, [], `Missing definitions for: ${missing.join(", ")}`);
});

test("LIVE: REQUIRED_IDS is non-empty (sanity — parser wired up)", () => {
  assert.ok(REQUIRED_IDS.length > 0, "REQUIRED_IDS should list kpi/stat metrics");
  for (const id of REQUIRED_IDS) {
    assert.ok(
      /^(ov|acct)\./.test(id),
      `${id} should be namespaced ov.* or acct.*`,
    );
  }
});

test("LIVE: exempt ids are not in REQUIRED_IDS (composites skip tooltips)", () => {
  for (const id of EXEMPT_IDS) {
    assert.ok(!REQUIRED_IDS.includes(id), `${id} should be exempt, not required`);
  }
});

// node:test's top-level test() calls set process.exitCode to 1 on any failure
// when the file is run directly with `node`, and the process exits non-zero —
// so `node scripts/ci/check-metric-definitions.test.mjs` is CI-gateable
// (exit 0 if all pass, non-zero if any fail). No extra runner needed.
