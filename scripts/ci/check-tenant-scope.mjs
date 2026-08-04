// scripts/ci/check-tenant-scope.mjs
// Fails if any route handler touches a tenant-scoped table directly instead
// of through withTenantScope() (TEN-004). This repo has no ESLint -- this
// is a hand-written check matching check-dependency-audit.mjs's pattern.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTES_DIR = path.join(ROOT, "artifacts/api-server/src/routes");

// Scoped tables added in this milestone (Tasks 1-6) -- extend this list as
// MT-M1/MT-M2 add more.
const SCOPED_TABLES = [
  "cyclesTable",
  "inventoryItemsTable",
  "alertsTable",
  "tasksTable",
  "shipmentsTable",
  "facilityLogsTable",
  "sensorsTable",
  "growthProfilesTable",
  "accountingConnectionsTable",
  "seedLotsTable",
  "organizationMembersTable",
];

const DIRECT_CALL = new RegExp(
  `\\bdb\\.(select|insert|update|delete)\\([^)]*\\)[^;]*\\.(from|into|table)\\((${SCOPED_TABLES.join("|")})\\)`,
);

// Baseline: known pre-existing direct-access call sites that predate this
// check (deliberately deferred to MT-M1 by earlier tasks in this plan --
// rewiring these to use withTenantScope is out of MT-M0's scope). Keyed by
// the offending line's own trimmed content, not line number, so unrelated
// edits elsewhere in the file don't silently keep stale entries "matched."
// Shrink this list as MT-M1 rewires each handler -- an empty list means the
// check has no more baseline debt. Any NEW violation not in this list still
// fails CI.
const BASELINE_VIOLATIONS = new Set([
  "artifacts/api-server/src/routes/alerts.ts::rows = await db.select().from(alertsTable).orderBy(desc(alertsTable.createdAt));",
  "artifacts/api-server/src/routes/dashboard.ts::const allSensors = await db.select().from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ sensorCount }] = await db.select({ sensorCount: count() }).from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ cycleCount }] = await db.select({ cycleCount: count() }).from(cyclesTable);",
  "artifacts/api-server/src/routes/growthProfiles.ts::const profiles = await db.select().from(growthProfilesTable);",
  "artifacts/api-server/src/routes/sensors.ts::const rows = await db.select().from(sensorsTable);",
]);

const newViolations = [];
const baselineViolations = [];

for await (const file of glob("**/*.ts", { cwd: ROUTES_DIR })) {
  const fullPath = path.join(ROUTES_DIR, file);
  const relPath = path.relative(ROOT, fullPath);
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (DIRECT_CALL.test(line) && !content.includes("withTenantScope")) {
      const key = `${relPath}::${line.trim()}`;
      if (BASELINE_VIOLATIONS.has(key)) {
        baselineViolations.push(`${relPath}:${i + 1}: ${line.trim()}`);
      } else {
        newViolations.push(`${relPath}:${i + 1}: ${line.trim()}`);
      }
    }
  });
}

if (newViolations.length > 0) {
  console.error("Direct scoped-table access found outside withTenantScope:\n");
  for (const v of newViolations) console.error(`  ${v}`);
  console.error(`\n${newViolations.length} new violation(s). Route this through withTenantScope() (lib/db/src/scope.ts).`);
  process.exit(1);
}

console.log(
  `check-tenant-scope: clean (${SCOPED_TABLES.length} scoped tables checked, 0 new violations, ${baselineViolations.length} known baseline items deferred to MT-M1)`,
);
