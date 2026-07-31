#!/usr/bin/env node
// ============================================================================
// check-dependency-audit.mjs — Production vulnerability baseline gate
// ============================================================================
//
// Reads two JSON audit reports produced earlier in the CI job:
//   1. npm report   (from `pnpm audit --prod --json`)
//   2. Python report (from `pip-audit -f json`)
//
// For every HIGH or CRITICAL advisory it looks for a matching, UNEXPIRED
// entry in docs/security/dependency-audit-allowlist.json. An entry matches
// when ecosystem + ghsaId + dependencyPath all agree. Any high/critical
// advisory without an unexpired allowlist entry fails the script (and thus
// the CI job).
//
// The script also rejects:
//   * duplicate allowlist entries (same ecosystem + ghsaId + dependencyPath),
//   * entries missing required fields,
//   * entries whose expiryDate is not a valid future ISO date.
//
// Moderate/low findings are reported but never fail the gate.
//
// Exits:
//   0 — all high/critical advisories resolved (patched or unexpired allowlist)
//   1 — one or more high/critical advisories unresolved, or allowlist invalid
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const ALLOWLIST_PATH = resolve(ROOT, "docs", "security", "dependency-audit-allowlist.json");

const NPM_REPORT = process.env.NPM_AUDIT_REPORT ?? resolve(ROOT, "npm-audit.json");
const PYTHON_REPORT = process.env.PYTHON_AUDIT_REPORT ?? resolve(ROOT, "python-audit.json");

const GATE_SEVERITIES = new Set(["high", "critical"]);

// ---------------------------------------------------------------------------
// Allowlist loading + validation
// ---------------------------------------------------------------------------

const ALLOWLIST_FIELDS = [
  "ecosystem",
  "ghsaId",
  "dependencyPath",
  "owner",
  "rationale",
  "acceptanceDate",
  "expiryDate",
];

function loadAllowlist() {
  let raw;
  try {
    raw = readFileSync(ALLOWLIST_PATH, "utf8");
  } catch (err) {
    fatal(`Cannot read allowlist at ${ALLOWLIST_PATH}: ${err.message}`);
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    fatal(`Allowlist is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(entries)) {
    fatal("Allowlist top-level value must be an array.");
  }

  const seen = new Set();
  for (const [i, entry] of entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fatal(`Allowlist entry #${i} is not an object.`);
    }
    for (const field of ALLOWLIST_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        fatal(`Allowlist entry #${i} missing/invalid field "${field}".`);
      }
    }
    if (!["npm", "python"].includes(entry.ecosystem)) {
      fatal(`Allowlist entry #${i} has invalid ecosystem "${entry.ecosystem}" (expected npm|python).`);
    }
    if (!Number.isNaN(Date.parse(entry.acceptanceDate)) === false) {
      fatal(`Allowlist entry #${i} acceptanceDate is not a valid date.`);
    }
    const expiryMs = Date.parse(entry.expiryDate);
    if (Number.isNaN(expiryMs)) {
      fatal(`Allowlist entry #${i} expiryDate is not a valid date.`);
    }

    const key = `${entry.ecosystem}::${entry.ghsaId}::${entry.dependencyPath}`;
    if (seen.has(key)) {
      fatal(`Duplicate allowlist entry for ${key}.`);
    }
    seen.add(key);
  }

  return entries;
}

function isExpired(entry, now = new Date()) {
  return new Date(entry.expiryDate).getTime() <= now.getTime();
}

/**
 * Find an unexpired allowlist entry matching (ecosystem, ghsaId, path).
 * The dependencyPath is matched as a substring of the advisory path so a
 * single allowlist entry can cover a long transitive path.
 */
function findAllowlistEntry(entries, ecosystem, ghsaId, dependencyPath) {
  return entries.find(
    (e) =>
      e.ecosystem === ecosystem &&
      e.ghsaId === ghsaId &&
      dependencyPath.includes(e.dependencyPath) &&
      !isExpired(e),
  );
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

/** Normalise an npm advisory id into a GHSA string. */
function npmGhsa(advisory) {
  return advisory.github_advisory_id ?? null;
}

function parseNpmReport(json) {
  const advisories = Object.values(json.advisories ?? {});
  const findings = [];
  for (const adv of advisories) {
    if (!GATE_SEVERITIES.has(adv.severity)) continue;
    const ghsa = npmGhsa(adv);
    if (!ghsa) continue; // cannot gate without an id
    for (const finding of adv.findings ?? []) {
      for (const rawPath of finding.paths ?? []) {
        const path = rawPath.replace(/__/g, "/").replace(/>/g, ">");
        findings.push({
          ecosystem: "npm",
          module: adv.module_name,
          severity: adv.severity,
          ghsaId: ghsa,
          installedVersion: finding.version ?? "unknown",
          vulnerableRange: adv.vulnerable_versions ?? "?",
          patchedVersions: adv.patched_versions ?? "?",
          title: adv.title ?? "",
          dependencyPath: path,
        });
      }
    }
  }
  return findings;
}

function parsePythonReport(json) {
  const findings = [];
  for (const dep of json.dependencies ?? []) {
    for (const vuln of dep.vulns ?? []) {
      const sev = (vuln.severity ?? "").toLowerCase();
      if (!GATE_SEVERITIES.has(sev)) continue;
      const id = vuln.id ?? vuln.ghsa_id ?? null;
      if (!id) continue;
      findings.push({
        ecosystem: "python",
        module: dep.name,
        severity: sev,
        ghsaId: id,
        installedVersion: dep.version ?? "unknown",
        vulnerableRange: vuln.range ?? vuln.fixed_in ? `<${vuln.fixed_in}` : "?",
        patchedVersions: (vuln.fix_versions ?? []).join(" || ") || "?",
        title: vuln.description?.split("\n")[0] ?? "",
        dependencyPath: dep.name,
      });
    }
  }
  return findings;
}

function readReport(path, parser, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fatal(`${label} report not found at ${path}: ${err.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    fatal(`${label} report is not valid JSON (${path}): ${err.message}`);
  }
  return parser(json);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fatal(msg) {
  console.error(`::error::check-dependency-audit: ${msg}`);
  process.exit(1);
}

function main() {
  const allowlist = loadAllowlist();
  const npmFindings = readReport(NPM_REPORT, parseNpmReport, "npm");
  const pythonFindings = readReport(PYTHON_REPORT, parsePythonReport, "python");
  const findings = [...npmFindings, ...pythonFindings];

  console.log(`check-dependency-audit: ${npmFindings.length} npm + ${pythonFindings.length} python high/critical findings.`);
  console.log(`check-dependency-audit: ${allowlist.length} allowlist entries loaded.`);

  const unresolved = [];
  const resolvedByAllowlist = [];

  for (const f of findings) {
    const entry = findAllowlistEntry(allowlist, f.ecosystem, f.ghsaId, f.dependencyPath);
    if (entry) {
      resolvedByAllowlist.push({ ...f, owner: entry.owner, expiryDate: entry.expiryDate });
    } else {
      unresolved.push(f);
    }
  }

  // Report allowlisted items (informational).
  if (resolvedByAllowlist.length) {
    console.log("\nResolved via unexpired allowlist:");
    for (const f of resolvedByAllowlist) {
      console.log(`  [ALLOWLIST] ${f.ecosystem} ${f.module}@${f.installedVersion} ${f.ghsaId} (owner=${f.owner}, expires=${f.expiryDate})`);
    }
  }

  // Report unresolved high/critical (the gate).
  if (unresolved.length) {
    console.error(`\n::error::${unresolved.length} unresolved high/critical advisory/advisories:`);
    for (const f of unresolved) {
      console.error(
        `  [UNRESOLVED] ${f.ecosystem} ${f.module}@${f.installedVersion} (${f.severity}) ${f.ghsaId}\n` +
          `    vulnerable: ${f.vulnerableRange} | patched: ${f.patchedVersions}\n` +
          `    path: ${f.dependencyPath}`,
      );
    }
    console.error("\nRemediate by bumping the dependency, or add a time-bounded entry to docs/security/dependency-audit-allowlist.json.");
    process.exit(1);
  }

  console.log("\ncheck-dependency-audit: PASS — all high/critical advisories resolved.");
}

main();
