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
// lib/ added after MT-M1's final review found a real violation invisible to
// this guard: lib/accounting/quickbooks.ts touched accounting_connections
// directly with no withTenantScope, and this scan only ever looked at
// routes/. Tenant-scoped tables are touched from lib/ too (accounting,
// metrics), not just route handlers.
const LIB_DIR = path.join(ROOT, "artifacts/api-server/src/lib");

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

// Whole-file regex matching a direct `db.<verb>(...)...<.from/.into/.table>(scoped)`
// chain anywhere in the file, even when spread across multiple lines (Drizzle's
// standard chain style puts `db` at the end of one line and `.select()` /
// `.from(...)` on subsequent lines).
//
// Two deviations from the brief's first-draft pattern, both forced by what the
// codebase actually looks like (verified empirically against seedLots.ts and a
// scratch file before trusting this):
//   1. `\s*\.\s*` around the dot between `db` and the verb. The brief's
//      `\bdb\.(verb)` required `db.select` to be contiguous, which never holds
//      for this repo's multi-line style (`const x = await db\n  .select()`).
//      That literal pattern missed seedLots.ts's GET /seed-lots/lookup entirely
//      AND failed its own Step 2 scratch-file check.
//   2. `[^;]*?` (not `[\s\S]*?`) between the call opening and `.from(...)`.
//      `[^;]` bounds the span to a single statement (every chain ends with
//      `;`), so a match can't swallow an unrelated later `db.` call in the same
//      file. The unbounded `[\s\S]*?` produced cross-statement false positives:
//      e.g. layout.ts's `.from(racksTable)` (non-scoped) spanned forward to a
//      later `.from(cyclesTable)` and misattributed a violation to the wrong
//      line. `[^;]` still matches newlines, so genuine multi-line chains within
//      one statement are still caught.
const DIRECT_CALL = new RegExp(
  `\\bdb\\s*\\.\\s*(select|insert|update|delete)\\([^;]*?\\.(from|into|table)\\((${SCOPED_TABLES.join("|")})\\)`,
  "g",
);

// Baseline: known pre-existing direct-access call sites that predate this
// check (deliberately deferred to MT-M1 by earlier tasks in this plan --
// rewiring these to use withTenantScope is out of MT-M0's scope). Keyed by
// the offending line's own trimmed content, not line number, so unrelated
// edits elsewhere in the file don't silently keep stale entries "matched."
// Shrink this list as MT-M1 rewires each handler -- an empty list means the
// check has no more baseline debt. Any NEW violation not in this list still
// fails CI.
//
// Three groups here. (A) and (B) are pre-existing deferred debt (nothing in
// either was introduced after the check first shipped in MT-M0 Task 10);
// (C) is PERMANENT, not debt to fix later -- see its own block below.
//
//  (A) Three SINGLE-LINE call sites that the original per-line regex caught.
//      (alerts.ts, growthProfiles.ts's route handler, and sensors.ts's
//      single-line entries were dropped once Tasks 4/7/8 rewired those
//      handlers to withTenantScope -- the file-level withTenantScope check
//      now skips those files entirely, so the entries can never match again.)
//
//  (B) MULTI-LINE call sites (15 distinct keys -- some keys, e.g. cycles.ts's
//      repeated `const [profile] = await db` chain-start, cover several
//      handlers at once) that the old single-line regex was blind to and that
//      MT-M1 Task 3's multi-line-aware regex now sees for the first time.
//      They are the same category of deferred debt as group (A), just
//      previously invisible; baselining them keeps CI green while MT-M1's
//      route-sweep tasks (4-8) rewire each handler to withTenantScope and
//      then delete the now-fixed entries. Files NOT covered by any MT-M1
//      sweep task (dashboard.ts, facility-readiness.ts's accounting line,
//      layout.ts) stay baselined as explicitly-tracked deferred debt.
//
//  (C) TWO PERMANENT entries -- TEN-008's deliberate bootstrap-style
//      organization_members lookups: GET /facilities's org resolution
//      (facilities.ts) and wizard.ts's getOrganizationId helper. Both
//      queries filter organization_members by userId directly in their WHERE
//      clause before any row ever reaches the app -- exactly matching
//      resolveTenantContext's own established bootstrap pattern in
//      artifacts/api-server/src/middlewares/tenantContext.ts. That file
//      lives in middlewares/, not routes/ or lib/, so this scanner never
//      looks at it -- which is why an identical pattern was never flagged
//      there. Unlike every entry in groups (A) and (B), these two are NOT
//      "MT-M1 deferred debt to fix later": both routes run before a
//      facility/tenant is even known (there is no req.tenant yet at that
//      point in the request lifecycle), so they can never be wrapped in
//      withTenantScope -- that wrapper requires a resolved tenant, which is
//      precisely what these lookups exist to bootstrap in the first place.
const BASELINE_VIOLATIONS = new Set([
  // --- (A) original single-line baselines (pre-date the multi-line fix) ---
  "artifacts/api-server/src/routes/dashboard.ts::const allSensors = await db.select().from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ sensorCount }] = await db.select({ sensorCount: count() }).from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ cycleCount }] = await db.select({ cycleCount: count() }).from(cyclesTable);",
  // --- (B) multi-line call sites first visible after MT-M1 Task 3's fix ---
  // badTrays.ts (Task 7):
  "artifacts/api-server/src/routes/badTrays.ts::const [cycle] = await db",
  // cycles.ts (Task 6 rewires the whole file -> it then contains
  // withTenantScope and is skipped entirely, so all four keys clear at once;
  // each key intentionally covers several handlers sharing the same
  // chain-start line):
  "artifacts/api-server/src/routes/cycles.ts::const rows = await db",
  "artifacts/api-server/src/routes/cycles.ts::const [profile] = await db",
  "artifacts/api-server/src/routes/cycles.ts::const [cycle] = await db",
  "artifacts/api-server/src/routes/cycles.ts::const [cycleRow] = await db",
  // dashboard.ts: NOT in any MT-M1 sweep task -> permanent deferred debt:
  "artifacts/api-server/src/routes/dashboard.ts::const runningRows = await db",
  "artifacts/api-server/src/routes/dashboard.ts::const completedRows = await db",
  "artifacts/api-server/src/routes/dashboard.ts::const activeSeedLotsRows = await db",
  "artifacts/api-server/src/routes/dashboard.ts::const currentAlerts = await db",
  // facility-readiness.ts: the accounting lookup below is not in any MT-M1
  // sweep task -> deferred debt (the two (A) entries above are also here):
  "artifacts/api-server/src/routes/facility-readiness.ts::const [qboConnection] = await db",
  // growthProfiles.ts: the only remaining direct `db.` access in this file is
  // the pilot-bootstrap seedDataIfEmpty() helper (NOT the route handler --
  // Task 7 rewired that to withTenantScope). The file-level withTenantScope
  // check therefore skips the whole file, so this entry is dead debt
  // documenting the seed helper's deliberately-deferred bootstrap access
  // (replaced by TEN-013 demo-mode provisioning in MT-M2, not this milestone):
  "artifacts/api-server/src/routes/growthProfiles.ts::const existing = await db",
  // layout.ts: NOT in any MT-M1 sweep task -> permanent deferred debt:
  "artifacts/api-server/src/routes/layout.ts::const activeCycles = await db",
  "artifacts/api-server/src/routes/layout.ts::const [activeCyclesRow] = await db",
  // shipments.ts (Task 4):
  "artifacts/api-server/src/routes/shipments.ts::const rows = await db",
  // --- (C) TEN-008's PERMANENT bootstrap-style organization_members lookups
  //         (NOT deferred debt -- these will never be wrapped in
  //         withTenantScope; see the header comment above for the full
  //         rationale). Both queries filter organization_members by userId
  //         directly in their WHERE clause before any row reaches the app,
  //         exactly matching resolveTenantContext's own bootstrap pattern in
  //         middlewares/tenantContext.ts -- a file this scanner never
  //         inspects (it lives in middlewares/, not routes/ or lib/), which
  //         is why an identical pattern was never flagged there. Both routes
  //         run before a facility/tenant is even known (no req.tenant exists
  //         yet at this point in the request lifecycle), so there is no
  //         tenant scope to wrap them in -- they exist to bootstrap the very
  //         tenant context that withTenantScope would later consume.
  "artifacts/api-server/src/routes/facilities.ts::const [membership] = await db",
  "artifacts/api-server/src/routes/wizard.ts::const [membership] = await db",
]);

const newViolations = [];
const baselineViolations = [];

for (const scanDir of [ROUTES_DIR, LIB_DIR]) {
  for await (const file of glob("**/*.ts", { cwd: scanDir })) {
    const fullPath = path.join(scanDir, file);
    const relPath = path.relative(ROOT, fullPath);
    const content = readFileSync(fullPath, "utf8");

    // A file that already routes its DB access through withTenantScope is
    // considered clean regardless of raw db.<verb>( chains it may still
    // contain — checked once per file, before scanning its matches.
    if (content.includes("withTenantScope")) continue;

    for (const match of content.matchAll(DIRECT_CALL)) {
      // Map the match's character offset back to a 1-based line number so the
      // report stays useful to a human reading the file.
      const upToMatch = content.slice(0, match.index);
      const lineNumber = upToMatch.split("\n").length;
      // Report the specific line the db.<verb>( call starts on, trimmed, so
      // baseline keys stay stable and readable (not the whole multi-line match).
      const startLine = content.split("\n")[lineNumber - 1].trim();
      const key = `${relPath}::${startLine}`;
      if (BASELINE_VIOLATIONS.has(key)) {
        baselineViolations.push(`${relPath}:${lineNumber}: ${startLine}`);
      } else {
        newViolations.push(`${relPath}:${lineNumber}: ${startLine}`);
      }
    }
  }
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
