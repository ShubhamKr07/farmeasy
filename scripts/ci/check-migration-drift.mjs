#!/usr/bin/env node
// ============================================================================
// check-migration-drift.mjs — Staging migration-drift detector (read-only)
// ============================================================================
//
// WHAT IT PROVES: that a persistent Supabase environment (staging) carries
// the SAME number of applied migrations as the repository's migration files,
// for BOTH migration systems this monorepo runs:
//
//   Drizzle:   repo files lib/db/drizzle/*.sql     vs  drizzle.__drizzle_migrations
//   Supabase:  repo files supabase/migrations/     vs  supabase_migrations.schema_migrations
//
// WHY IT EXISTS: staging silently drifted 9 Drizzle migrations behind the
// repo TWICE before — caught only by chance. A persistent environment that
// lags the repo's migration history is the dangerous case: code deployed
// against a schema it assumes but the database lacks causes silent runtime
// failures. This check turns that latent gap into a loud, daily, fail-the-job
// alert (exit 1) instead of an incident discovered after the fact. See the
// accompanying .github/workflows/migration-drift-check.yml (daily cron).
//
// READ-ONLY / SAFE: this script issues SELECT count(*) statements only. It
// never writes, creates, alters, or drops anything. It is safe to run
// against any environment, including production.
//
// Repo counts come from `git ls-files` (TRACKED files only), so the untracked
// bootstrap supabase/migrations/00000_enable_pgtap.sql — which CI never
// replays and which is absent from the migration ledger — is excluded, and
// the repo count matches exactly what CI replays. (The same bootstrap file
// is also filtered by name as a belt-and-suspenders guard against it ever
// being committed.)
//
// The pg driver and CA-pinned TLS posture are reused verbatim from the rest
// of the repo: `pg` (as scripts/ci/verify-db-role.mjs uses) and
// buildSslConfig() from lib/db/src/ssl.ts (as lib/db/scripts/migrate.mjs
// uses), so this check, the app pool, and the migrator never drift on TLS.
//
// Exits:
//   0 — applied counts equal repo counts for BOTH systems.
//   1 — any mismatch (BEHIND = applied < repo, the dangerous drift; or
//       AHEAD = applied > repo), a missing ledger table, a git error, or a
//       connection error.
//
// Env:
//   DATABASE_URL      (required) direct or session-pooler Postgres URL.
//   DATABASE_CA_CERT  (optional; REQUIRED for non-local hosts) PEM CA cert.
//                     Whitespace is stripped from DATABASE_URL (mirrors
//                     scripts/ci/verify-staging-supabase.mjs — Render pastes
//                     env vars line-wrapped). DATABASE_CA_CERT is left raw so
//                     its PEM newlines are preserved.
// ============================================================================

import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { buildSslConfig } from "../../lib/db/src/ssl.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const DRIZZLE_DIR = "lib/db/drizzle"; // *.sql migrations (meta/ holds JSON only)
const SUPABASE_DIR = "supabase/migrations";
const SUPABASE_BOOTSTRAP = "00000_enable_pgtap.sql"; // untracked, never replayed

// ── Env ─────────────────────────────────────────────────────────────────────
// Strip ALL whitespace from the URL (a Postgres URL contains none; Render's
// line-wrapped pastes embed newlines that break the handshake). Leave
// DATABASE_CA_CERT untouched — buildSslConfig() reads it raw from the env so
// the PEM's significant newlines survive.
const DATABASE_URL = (process.env.DATABASE_URL ?? "").replace(/\s/g, "");

if (!DATABASE_URL) {
  console.error(
    "::error::check-migration-drift: DATABASE_URL is required " +
      "(a direct or session-pooler Postgres URL).",
  );
  console.error(
    "  Usage: DATABASE_URL=... DATABASE_CA_CERT=<PEM> " +
      "node scripts/ci/check-migration-drift.mjs",
  );
  console.error(
    "  (DATABASE_CA_CERT is required for non-local hosts — " +
      "see lib/db/src/ssl.ts.)",
  );
  process.exit(1);
}

// ── Repo-side counts (git-tracked files only) ───────────────────────────────

/** git ls-files for a pathspec glob, run at the repo root, as a sorted array. */
function gitLsFiles(pattern) {
  const out = execSync(`git ls-files -- "${pattern}"`, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Count tracked migration files for one system.
 *   dir           repository path holding the *.sql migrations
 *   excludeNames  exact filenames (basename) to drop even if tracked
 *                 (guards the pgtap bootstrap; meta/ has no .sql so it is
 *                 excluded by the glob naturally, plus a /meta/ filter).
 */
function countRepoMigrations(dir, excludeNames = []) {
  const exclude = new Set(excludeNames);
  const all = gitLsFiles(`${dir}/*.sql`);
  const files = all.filter((f) => {
    const base = f.split("/").pop();
    return !f.includes("/meta/") && !exclude.has(base);
  });
  return { count: files.length, files };
}

const drizzleRepo = countRepoMigrations(DRIZZLE_DIR);
const supabaseRepo = countRepoMigrations(SUPABASE_DIR, [SUPABASE_BOOTSTRAP]);

console.log(
  `check-migration-drift: repo counts — ` +
    `Drizzle ${drizzleRepo.count} (${DRIZZLE_DIR}/*.sql), ` +
    `Supabase ${supabaseRepo.count} (${SUPABASE_DIR}/*.sql, tracked only).`,
);

// ── DB-side applied counts (SELECT only) ────────────────────────────────────

/**
 * Run `SELECT count(*)::int` against a ledger relation, guarding for the
 * table not existing yet (e.g. a fresh DB before any migration). Returns a
 * structured result rather than throwing so the report stays readable.
 */
async function countApplied(client, sql, relation) {
  try {
    const { rows } = await client.query(sql);
    return { ok: true, count: Number(rows[0].count) };
  } catch (err) {
    const msg = err?.message ?? String(err);
    // SQLSTATE 42P01 = undefined_table. Surface a clear cause either way.
    if (err?.code === "42P01" || /does not exist|relation/i.test(msg)) {
      return { ok: false, error: `ledger table missing: ${relation} (${msg})` };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Turn an applied-count result into a status vs the repo count.
 *   OK     applied === repo
 *   BEHIND applied <  repo   ← the dangerous drift this script exists to catch
 *   AHEAD  applied >  repo
 *   ERROR  the ledger table is missing / the query failed
 */
function classify(repo, appliedResult) {
  if (!appliedResult.ok) {
    return { state: "ERROR", detail: appliedResult.error };
  }
  const applied = appliedResult.count;
  if (applied === repo) return { state: "OK", applied };
  if (applied < repo) return { state: "BEHIND", applied, delta: repo - applied };
  return { state: "AHEAD", applied, delta: applied - repo };
}

// ── Reporting helpers (console + GitHub step summary) ───────────────────────

const STATE_ICON = { OK: "✅", BEHIND: "🔴", AHEAD: "🟠", ERROR: "⚪" };
const STATE_ICON_TXT = { OK: "✓", BEHIND: "✗", AHEAD: "✗", ERROR: "✗" };

function stateText(state, res) {
  if (state === "OK") return "OK";
  if (state === "BEHIND")
    return `BEHIND by ${res.delta} ← STAGING HAS DRIFTED — apply pending migrations`;
  if (state === "AHEAD")
    return `AHEAD by ${res.delta} ← DB has migrations not in the repo`;
  return `ERROR — ${res.detail}`;
}

function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const SYSTEMS = [
  {
    name: "Drizzle",
    repoPath: `${DRIZZLE_DIR}/*.sql`,
    repo: drizzleRepo.count,
    sql: "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    relation: "drizzle.__drizzle_migrations",
  },
  {
    name: "Supabase",
    repoPath: `${SUPABASE_DIR}/*.sql`,
    repo: supabaseRepo.count,
    sql: "SELECT count(*)::int AS count FROM supabase_migrations.schema_migrations",
    relation: "supabase_migrations.schema_migrations",
  },
];

let exitCode = 0;
let client;

try {
  // buildSslConfig() reuses the repo's shared CA-pinned TLS posture:
  //   local/disposable  → ssl: false
  //   hosted            → { ca: DATABASE_CA_CERT, rejectUnauthorized: true }
  // and throws (fail-closed) for a non-local host with no DATABASE_CA_CERT.
  let host = DATABASE_URL;
  try {
    host = new URL(DATABASE_URL).host;
  } catch {
    /* not a parseable URL — log it raw minus nothing (it has no whitespace) */
  }
  console.log(`check-migration-drift: connecting to ${host} …`);
  client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: buildSslConfig(DATABASE_URL),
  });
  await client.connect();

  const rows = [];
  for (const s of SYSTEMS) {
    const applied = await countApplied(client, s.sql, s.relation);
    const status = classify(s.repo, applied);
    rows.push({ ...s, applied, status });
  }

  // ── Console report ───────────────────────────────────────────────────────
  console.log("");
  console.log("──── migration drift check ────");
  for (const r of rows) {
    const appliedStr = r.applied.ok ? String(r.applied.count) : "?";
    console.log(
      `${STATE_ICON_TXT[r.status.state]} ${r.name.padEnd(8)} ` +
        `(${r.repoPath}): repo ${String(r.repo).padStart(3)} | applied ${appliedStr.padStart(3)}  ` +
        `— ${stateText(r.status.state, r.status)}`,
    );
  }

  const allOk = rows.every((r) => r.status.state === "OK");

  // ── GitHub step summary (markdown, appended) ─────────────────────────────
  const mdRows = rows
    .map(
      (r) =>
        `| ${r.name} (\`${r.repoPath}\`) | ${r.repo} | ` +
        `${r.applied.ok ? r.applied.count : "—"} | ${STATE_ICON[r.status.state]} ${r.status.state}${
          r.status.state === "BEHIND" || r.status.state === "AHEAD" ? ` by ${r.status.delta}` : ""
        }${r.status.state === "ERROR" ? ` — ${r.status.detail}` : ""} |`,
    )
    .join("\n");

  const mdVerdict = allOk
    ? "✅ **No drift** — applied migration counts match the repo for both Drizzle and Supabase."
    : `🔴 **MIGRATION DRIFT DETECTED** — ${rows
        .filter((r) => r.status.state !== "OK")
        .map((r) => `${r.name} ${stateText(r.status.state, r.status)}`)
        .join("; ")}. A persistent environment that lags the repo is the dangerous case — apply pending migrations and re-run.`;

  appendSummary(
    `### Migration drift check\n\n` +
      `| System | Repo files | Applied | Status |\n` +
      `| --- | ---: | ---: | --- |\n` +
      `${mdRows}\n\n` +
      `${mdVerdict}\n`,
  );

  // ── Verdict + exit code ──────────────────────────────────────────────────
  if (allOk) {
    console.log(
      `\n✓ PASS: no drift — applied counts match the repo for both Drizzle and Supabase.`,
    );
  } else {
    const offenders = rows
      .filter((r) => r.status.state !== "OK")
      .map((r) => `${r.name} ${stateText(r.status.state, r.status)}`);
    console.error(
      `\n::error::check-migration-drift: drift detected — ${offenders.join("; ")}.`,
    );
    console.error(
      "  Repo vs applied: " +
        rows.map((r) => `${r.name} repo=${r.repo} applied=${r.applied.ok ? r.applied.count : "?"}`).join(", ") +
        ".",
    );
    exitCode = 1;
  }
} catch (err) {
  // A connection/TLS/SSL error (e.g. fail-closed buildSslConfig() throw, a
  // bad CA, a wrong host) lands here. Report clearly — never an ugly stack.
  // Fall back to err.code (pg surfaces useful SQLSTATE/socket codes like
  // ECONNREFUSED, 28P01, 08006) when the message is empty/terse.
  const reason =
    err?.message || err?.code || (typeof err === "string" ? err : "unknown error");
  console.error(
    `::error::check-migration-drift: could not complete the drift check — ${reason}`,
  );
  if (process.env.DEBUG && err?.stack) console.error(err.stack);
  // Mirror the summary on failure too, so the Actions step summary is never
  // silently blank when the check cannot even run.
  appendSummary(
    `### Migration drift check\n\n` +
      `⚪ **Could not complete the drift check** — \`${reason}\`.\n\n` +
      `Repo counts at check time: Drizzle ${drizzleRepo.count}, ` +
      `Supabase ${supabaseRepo.count} (applied counts unavailable).\n`,
  );
  exitCode = 1;
} finally {
  if (client) {
    try {
      await client.end();
    } catch {
      /* best-effort teardown */
    }
  }
}

process.exit(exitCode);
