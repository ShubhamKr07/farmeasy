#!/usr/bin/env node
/**
 * Mobile version adoption report (Release 1 promotion gate, Task 2 Step 7).
 *
 * Consumes three real-world exports and decides whether a mobile update may be
 * promoted out of "everyone must upgrade" compatibility mode:
 *
 *   --ios <csv>          App Store Connect version-adoption CSV
 *   --android <csv>      Play Console version-adoption CSV
 *   --api <ndjson>       Render API request logs (pino NDJSON) carrying the
 *                        mobile `X-FarmSmart-Client-Version` header
 *   --minimum-version V  Lowest version still supported (>= is supported)
 *   --threshold N        Minimum weighted supported share (default 0.99)
 *
 * Computes the *device-count-weighted* supported share across iOS + Android
 * (so a platform with 10x the devices correctly dominates the aggregate), and
 * separately scans the API log for any request whose known client version is
 * below the minimum inside the final 72 hours of the log window.
 *
 * Exit code is nonzero if EITHER gate fails:
 *   - weighted supported share < threshold, OR
 *   - >=1 unsupported-version API request inside the final 72h of the NDJSON.
 *
 * Prints a markdown report to stdout (the brief pipes it through
 * `tee docs/security/mobile-version-adoption.md`).
 *
 * ── Expected export schemas ────────────────────────────────────────────────
 * The exact column names of App Store Connect / Play Console exports vary by
 * report and locale, so the CSV parser is column-name-tolerant:
 *   • Version column: the header whose lowercased name contains "version" and
 *     (preferably) "name", but never "code". e.g. "App Version Name",
 *     "Version", "App Version".
 *   • Count column:   the first header matching a known adoption-count name
 *     (see COUNT_COLUMN_HINTS). e.g. "Devices", "Active Devices",
 *     "Installations", "Current Installations", "Active Users".
 *   • Count values may include thousands separators / '%'; these are stripped.
 *
 * The API NDJSON is the api-server's pino request log (one JSON object per
 * line). The mobile client version is recorded by app.ts's pino serializer as
 * `req.clientVersion`; the pino default timestamp key is `time` (epoch ms).
 * Both are detected defensively (top-level + nested, several timestamp keys).
 *
 * If your real export uses different column/field names, widen the detection
 * rules here rather than hand-editing the CSV — the parser prints the header it
 * saw when it cannot detect columns, to make that adjustment obvious.
 *
 * Tests live in scripts/ci/report-mobile-version-adoption.self-test.mjs and
 * exercise the pure functions below against small SYNTHETIC fixtures only.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── Flag parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { ios: null, android: null, api: null, minimumVersion: null, threshold: 0.99 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--ios":
        out.ios = next; i++; break;
      case "--android":
        out.android = next; i++; break;
      case "--api":
        out.api = next; i++; break;
      case "--minimum-version":
        out.minimumVersion = next; i++; break;
      case "--threshold":
        out.threshold = Number(next); i++; break;
      case "--help":
      case "-h":
        out.help = true; break;
      default:
        if (a?.startsWith("--")) {
          throw new Error(`unknown flag: ${a}`);
        }
    }
  }
  return out;
}

const USAGE = `Usage: report-mobile-version-adoption.mjs \\
  --ios <app-store-csv> --android <play-console-csv> --api <render-ndjson> \\
  --minimum-version <semver> [--threshold 0.99]`;

// ── Version comparison ─────────────────────────────────────────────────────
/**
 * Parse a version string into an array of integer segments, ignoring any
 * non-numeric qualifier ("1.2.3-beta" / "1.2.3 (4)" -> [1,2,3]).
 */
export function versionSegments(v) {
  if (v == null) return [];
  const parts = String(v).trim().split(/[.\s]/);
  const segs = [];
  for (const p of parts) {
    const m = p.match(/\d+/);
    if (m) segs.push(Number(m[0]));
  }
  return segs;
}

/**
 * Compare two version strings by numeric segments. Returns -1, 0, or 1.
 * Shorter arrays are zero-padded ("1.2" === "1.2.0").
 */
export function compareVersions(a, b) {
  const sa = versionSegments(a);
  const sb = versionSegments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const da = sa[i] ?? 0;
    const db = sb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isSupported(version, minimum) {
  return compareVersions(version, minimum) >= 0;
}

// ── CSV parsing ─────────────────────────────────────────────────────────────
/** Minimal RFC-4180-ish CSV line splitter honoring quoted fields. */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const COUNT_COLUMN_HINTS = [
  "active devices",
  "current installations",
  "installations",
  "daily devices",
  "active users",
  "devices",
  "installs",
  "users",
  "active device",
];

/** Lowercased, alphanumeric-only normalization for tolerant header matching. */
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pick the version column index (prefer *name*, never *code*). */
function findVersionColumn(headers) {
  const normed = headers.map(norm);
  // Prefer a "name" version column.
  let idx = normed.findIndex((h) => h.includes("version") && h.includes("name"));
  if (idx >= 0) return idx;
  // Any version column that is NOT a code.
  idx = normed.findIndex((h) => h.includes("version") && !h.includes("code"));
  return idx;
}

function findCountColumn(headers) {
  const normed = headers.map(norm);
  for (const hint of COUNT_COLUMN_HINTS) {
    const idx = normed.findIndex((h) => h === hint || h.includes(hint));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseCount(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[,%\s]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a version-adoption CSV into per-version device counts plus aggregates.
 *
 * @param {string} text   raw CSV contents
 * @param {string} platform  "ios" | "android" (for error messages)
 * @param {string} minimumVersion
 * @returns {{
 *   rows: Array<{version:string,count:number,supported:boolean}>,
 *   totalDevices:number, supportedDevices:number, unsupportedDevices:number,
 *   versionColumn:string, countColumn:string,
 * }}
 */
export function parseVersionAdoptionCsv(text, platform, minimumVersion) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    throw new Error(`${platform}: CSV is empty`);
  }
  const headers = parseCsvLine(lines[0]);
  const vCol = findVersionColumn(headers);
  const cCol = findCountColumn(headers);
  if (vCol < 0 || cCol < 0) {
    throw new Error(
      `${platform}: could not detect version/count columns. ` +
        `Saw header: ${JSON.stringify(headers)}. ` +
        `Widen findVersionColumn/findCountColumn detection rules to match your export.`,
    );
  }
  const rows = [];
  let totalDevices = 0;
  let supportedDevices = 0;
  let unsupportedDevices = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const version = cells[vCol];
    const count = parseCount(cells[cCol]);
    if (!version) continue;
    const supported = isSupported(version, minimumVersion);
    rows.push({ version, count, supported });
    totalDevices += count;
    if (supported) supportedDevices += count;
    else unsupportedDevices += count;
  }
  rows.sort((a, b) => b.count - a.count);
  return {
    rows,
    totalDevices,
    supportedDevices,
    unsupportedDevices,
    versionColumn: headers[vCol],
    countColumn: headers[cCol],
  };
}

// ── NDJSON (API request log) analysis ───────────────────────────────────────
const TS_KEYS = ["time", "timestamp", "ts", "@timestamp", "date"];

function readTimestampMs(obj) {
  for (const k of TS_KEYS) {
    if (obj[k] != null) {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) {
        // pino `time` is epoch ms; epoch seconds (10 digits) also tolerated.
        return n > 1e12 ? n : n * 1000;
      }
      const parsed = Date.parse(obj[k]);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function readClientVersion(obj) {
  // pino serializer nests under `req`; tolerate a flattened top-level copy too.
  const nested = obj?.req?.clientVersion;
  if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  const top = obj?.clientVersion;
  if (typeof top === "string" && top.trim() !== "") return top.trim();
  return null;
}

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 72 * HOUR_MS;

/**
 * Analyze mobile-version API request logs.
 *
 * A request is "unsupported" iff it carries a known client version that is
 * below the minimum. Requests with no version (web / pre-telemetry clients) are
 * counted separately and do NOT trip the 72h gate — the gate fires only on a
 * *known* unsupported version, matching the brief ("unsupported-version API
 * request").
 *
 * @param {string} text  NDJSON (one JSON object per line)
 * @param {string} minimumVersion
 * @returns {{
 *   total:number, withVersion:number, withoutVersion:number,
 *   unsupportedTotal:number, unsupportedInWindow:number,
 *   windowStartIso:string|null, windowEndIso:string|null,
 *   unsupportedVersions:Record<string,number>,
 *   malformed:number,
 * }}
 */
export function analyzeApiNdjson(text, minimumVersion) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  let total = 0;
  let withVersion = 0;
  let withoutVersion = 0;
  let unsupportedTotal = 0;
  let malformed = 0;
  let maxTs = null;
  const unsupported = []; // { ts, version }
  const unsupportedVersions = {};

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    total++;
    const ts = readTimestampMs(obj);
    if (ts != null && (maxTs == null || ts > maxTs)) maxTs = ts;
    const version = readClientVersion(obj);
    if (!version) {
      withoutVersion++;
      continue;
    }
    withVersion++;
    if (!isSupported(version, minimumVersion)) {
      unsupportedTotal++;
      unsupported.push({ ts, version });
      unsupportedVersions[version] = (unsupportedVersions[version] ?? 0) + 1;
    }
  }

  let unsupportedInWindow = 0;
  let windowStartIso = null;
  let windowEndIso = null;
  if (maxTs != null) {
    const start = maxTs - WINDOW_MS;
    windowStartIso = new Date(start).toISOString();
    windowEndIso = new Date(maxTs).toISOString();
    for (const u of unsupported) {
      if (u.ts != null && u.ts >= start && u.ts <= maxTs) unsupportedInWindow++;
    }
  }

  return {
    total,
    withVersion,
    withoutVersion,
    unsupportedTotal,
    unsupportedInWindow,
    windowStartIso,
    windowEndIso,
    unsupportedVersions,
    malformed,
  };
}

// ── Aggregate + report ──────────────────────────────────────────────────────
function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function topUnsupportedRows(rows, n) {
  return rows.filter((r) => !r.supported).slice(0, n);
}

function readOptionalFile(path) {
  if (!path) return null;
  return readFileSync(path, "utf8");
}

/**
 * @returns {{markdown:string, pass:boolean, reasons:string[]}}
 */
export function buildReport({
  minimumVersion,
  threshold,
  ios,
  android,
  api,
  generatedAt,
}) {
  const reasons = [];
  let totalDevices = 0;
  let supportedDevices = 0;
  const platforms = [];

  for (const [name, parsed] of [["iOS", ios], ["Android", android]]) {
    if (!parsed) continue;
    totalDevices += parsed.totalDevices;
    supportedDevices += parsed.supportedDevices;
    platforms.push({
      name,
      parsed,
      share: parsed.totalDevices > 0 ? parsed.supportedDevices / parsed.totalDevices : 0,
    });
  }

  const weightedShare = totalDevices > 0 ? supportedDevices / totalDevices : 0;
  const sharePass = weightedShare >= threshold;
  if (!sharePass) {
    reasons.push(
      `weighted supported share ${pct(weightedShare)} is below threshold ${pct(threshold)}`,
    );
  }

  let apiPass = true;
  let apiSummary = "_No API log provided._";
  if (api) {
    if (api.unsupportedInWindow > 0) {
      apiPass = false;
      reasons.push(
        `${api.unsupportedInWindow} unsupported-version API request(s) in the final 72h window ` +
          `(${api.windowStartIso} → ${api.windowEndIso})`,
      );
    }
    apiSummary = api.unsupportedInWindow > 0
      ? `**${api.unsupportedInWindow}** unsupported request(s) in the final 72h window`
      : `0 unsupported requests in the final 72h window (${api.windowStartIso} → ${api.windowEndIso})`;
  }

  const pass = sharePass && apiPass;
  const verdict = pass
    ? `**PASS** — meets threshold and no unsupported traffic in final 72h`
    : `**FAIL** — ${reasons.join("; ")}`;

  // ── assemble markdown ────────────────────────────────────────────────────
  const lines = [];
  lines.push("# Mobile Version Adoption Report");
  lines.push("");
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(`- **Minimum supported version:** \`${minimumVersion}\``);
  lines.push(`- **Threshold (weighted supported share):** ${pct(threshold)}`);
  lines.push(`- **Verdict:** ${verdict}`);
  lines.push("");
  lines.push("## Weighted supported share");
  lines.push("");
  lines.push("| Platform | Total devices | Supported devices | Share |");
  lines.push("|---|---:|---:|---:|");
  for (const p of platforms) {
    lines.push(
      `| ${p.name} | ${p.parsed.totalDevices.toLocaleString()} | ${p.parsed.supportedDevices.toLocaleString()} | ${pct(p.share)} |`,
    );
  }
  lines.push(
    `| **All (weighted)** | **${totalDevices.toLocaleString()}** | **${supportedDevices.toLocaleString()}** | **${pct(weightedShare)}** |`,
  );
  lines.push("");
  lines.push(`> ${sharePass ? "✅ Meets" : "❌ Below"} threshold of ${pct(threshold)}.`);
  lines.push("");

  lines.push("## Unsupported versions by device count");
  lines.push("");
  const unsupportedRows = platforms.flatMap((p) =>
    topUnsupportedRows(p.parsed.rows, 10).map((r) => ({ ...r, platform: p.name })),
  );
  if (unsupportedRows.length === 0) {
    lines.push("_No unsupported client versions in store adoption data._");
  } else {
    lines.push("| Platform | Version | Devices |");
    lines.push("|---|---|---:|");
    for (const r of unsupportedRows) {
      lines.push(`| ${r.platform} | \`${r.version}\` | ${r.count.toLocaleString()} |`);
    }
  }
  lines.push("");

  lines.push("## API request log (mobile client version)");
  lines.push("");
  if (api) {
    lines.push(`- Total parsed requests: **${api.total.toLocaleString()}**`);
    lines.push(`- Requests with a client version: **${api.withVersion.toLocaleString()}**`);
    lines.push(`- Requests without a version (web / pre-telemetry): ${api.withoutVersion.toLocaleString()}`);
    if (api.malformed > 0) lines.push(`- Unparseable lines skipped: ${api.malformed.toLocaleString()}`);
    lines.push(`- Unsupported-version requests (all time): **${api.unsupportedTotal.toLocaleString()}**`);
    lines.push(`- Unsupported-version requests in final 72h: ${apiSummary}`);
    if (Object.keys(api.unsupportedVersions).length > 0) {
      lines.push("");
      lines.push("Unsupported versions seen in API traffic:");
      lines.push("");
      lines.push("| Version | Requests |");
      lines.push("|---|---:|");
      for (const [v, c] of Object.entries(api.unsupportedVersions)
        .sort((a, b) => b[1] - a[1])) {
        lines.push(`| \`${v}\` | ${c.toLocaleString()} |`);
      }
    }
  } else {
    lines.push(apiSummary);
  }
  lines.push("");
  lines.push("---");
  lines.push(
    "_Regenerated by `scripts/ci/report-mobile-version-adoption.mjs`; do not edit by hand._",
  );
  lines.push("");

  return { markdown: lines.join("\n"), pass, reasons };
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.minimumVersion) {
    console.error(`✗ --minimum-version is required.\n${USAGE}`);
    process.exit(2);
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    console.error(`✗ --threshold must be a number in [0,1].`);
    process.exit(2);
  }
  if (!args.ios && !args.android && !args.api) {
    console.error(`✗ at least one of --ios / --android / --api is required.\n${USAGE}`);
    process.exit(2);
  }

  const generatedAt = new Date().toISOString();
  let iosParsed = null;
  let androidParsed = null;
  let apiParsed = null;

  try {
    if (args.ios) iosParsed = parseVersionAdoptionCsv(readOptionalFile(args.ios), "ios", args.minimumVersion);
    if (args.android) androidParsed = parseVersionAdoptionCsv(readOptionalFile(args.android), "android", args.minimumVersion);
    if (args.api) apiParsed = analyzeApiNdjson(readOptionalFile(args.api), args.minimumVersion);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }

  const { markdown, pass } = buildReport({
    minimumVersion: args.minimumVersion,
    threshold: args.threshold,
    ios: iosParsed,
    android: androidParsed,
    api: apiParsed,
    generatedAt,
  });

  process.stdout.write(markdown);
  if (!pass) {
    process.stderr.write("\n✗ adoption gate FAILED — see report above.\n");
    process.exit(1);
  }
  process.stderr.write("\n✓ adoption gate passed.\n");
  process.exit(0);
}

const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  main();
}

export { parseArgs, USAGE, WINDOW_MS };
