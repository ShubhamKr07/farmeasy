// scripts/ci/check-metric-definitions.mjs
//
// CI check (HLP-001/002, Task 7): every metric in the Overview and Accounting
// registries whose `render` is "kpi" or "stat" MUST have an entry in the
// definitions catalog so its tooltip never renders the silent
// "Definition unavailable" fallback. Composite metrics (ov.combined.*,
// ov.cycles.actionRequiredList) are excluded — they don't carry a tooltip.
//
// Runs as a CLI (`node scripts/ci/check-metric-definitions.mjs`) and exits
// non-zero with a clear message naming every missing metric. Also exports
// the helper functions + the list of required ids so the companion self-test
// (scripts/ci/check-metric-definitions.test.mjs) can validate the diff
// without re-implementing the parser.
//
// Paths are resolved relative to the repo root (this script lives under
// scripts/ci/, so ../../ is the repo root).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

export const REGISTRY_PATHS = {
  overview: path.join(REPO_ROOT, "lib", "metrics", "src", "registry-overview.ts"),
  accounting: path.join(REPO_ROOT, "lib", "metrics", "src", "registry-accounting.ts"),
};

export const CATALOG_PATH = path.join(
  REPO_ROOT,
  "artifacts",
  "admin-dashboard",
  "src",
  "lib",
  "definitions-catalog.ts",
);

/**
 * Metric ids that are exempt from the catalog requirement. Composites render
 * their own bespoke UI (charts/lists) and don't carry a definition tooltip,
 * so a catalog entry would never be read. Keep this list small and explicit.
 */
export const EXEMPT_IDS = new Set([
  "ov.combined.dailyYieldSeeding",
  "ov.combined.trend7d",
  "ov.cycles.actionRequiredList",
]);

/**
 * Parse a registry-*.ts source file into { id, render } pairs. Each metric is
 * a single-line object literal in the registry (one line per entry), so a
 * line-oriented regex is robust and avoids a TS parser dependency. The regex
 * requires an `id` and a `render` on the same object literal line — every
 * shipped metric has both (see registry-overview.ts / registry-accounting.ts).
 *
 * @param {string} src
 * @returns {{ id: string, render: string }[]}
 */
export function parseRegistry(src) {
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    const idMatch = line.match(/id:\s*"([^"]+)"/);
    const renderMatch = line.match(/render:\s*"([^"]+)"/);
    if (idMatch && renderMatch) {
      out.push({ id: idMatch[1], render: renderMatch[1] });
    }
  }
  return out;
}

/**
 * Extract the catalog's id keys from definitions-catalog.ts. The catalog is a
 * flat `Record<string, DefinitionEntry>` literal whose keys are the metric
 * ids (e.g. `"ov.yield.week": { ... }`). We match the `"ns.foo": {` form,
 * scoped to the metric id namespaces so unrelated string keys in comments
 * don't false-positive.
 *
 * @param {string} src
 * @returns {Set<string>}
 */
export function parseCatalogIds(src) {
  const ids = new Set();
  const re = /^\s*"(ov|acct)\.[a-zA-Z0-9._]+":\s*\{/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    ids.add(m[0].trim().match(/"([^"]+)"/)[1]);
  }
  return ids;
}

/**
 * Compute the set of metric ids that MUST have a catalog entry: every
 * kpi/stat metric from both registries, minus the explicit exempt list.
 *
 * @returns {{ required: string[], catalogIds: Set<string>, missing: string[] }}
 */
export function computeMissing() {
  const files = Object.entries(REGISTRY_PATHS).map(([name, p]) => [
    name,
    fs.readFileSync(p, "utf8"),
  ]);

  const all = [];
  for (const [, src] of files) {
    for (const { id, render } of parseRegistry(src)) {
      if (render === "kpi" || render === "stat") {
        all.push(id);
      }
    }
  }

  const catalogIds = parseCatalogIds(fs.readFileSync(CATALOG_PATH, "utf8"));
  const required = all.filter((id) => !EXEMPT_IDS.has(id));
  const missing = required.filter((id) => !catalogIds.has(id));
  return { required, catalogIds, missing };
}

/**
 * The full list of required ids — exported for test validation (the
 * self-test asserts the list is non-empty and matches the registries).
 */
export const REQUIRED_IDS = computeMissing().required;

function main() {
  const { required, missing } = computeMissing();
  if (missing.length > 0) {
    console.error(
      `✖ check-metric-definitions: ${missing.length} metric(s) missing a definition entry.`,
    );
    console.error(
      `  Missing definitions for: ${missing.join(", ")}`,
    );
    console.error(
      `  Add an entry to artifacts/admin-dashboard/src/lib/definitions-catalog.ts ` +
        `(see the DEFINITIONS_CATALOG comment for the format).`,
    );
    console.error(
      `  (${required.length} kpi/stat metric(s) require a catalog entry.)`,
    );
    process.exit(1);
  }
  console.log(
    `✔ check-metric-definitions: all ${required.length} kpi/stat metric(s) have a definition entry.`,
  );
}

// Run as CLI only when invoked directly, not when imported by the test.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main();
}
