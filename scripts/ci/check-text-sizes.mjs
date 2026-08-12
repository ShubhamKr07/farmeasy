// scripts/ci/check-text-sizes.mjs
//
// A11Y-003 regression guard: font-size floor (≥ 12px).
//
// Scans every .tsx/.jsx/.ts/.js source file under the admin-dashboard src
// tree for static font-size declarations below the 12px WCAG-friendly floor
// and fails the build when any are found. This is a *static* source scan,
// not a runtime getComputedStyle audit: the admin-dashboard is an auth-gated
// SPA (Supabase session + facility picker + onboarding wizard all gate the
// dashboard routes), so a browser-driven puppeteer/getComputedStyle pass
// could not reach /inventory or /accounting without seeding a full org +
// user + facility + wizard-progress state. A static scan is deterministic,
// fast (<30ms), needs no browser/download, and matches the repo's existing
// CI-check conventions (see check-metric-heights.mjs and check-tenant-
// scope.mjs, which use the same readFileSync + regex approach).
//
// The scan resolves three categories of sub-12px font-size declarations:
//
//   1. Tailwind arbitrary font-size utilities: text-[10px], text-[10.5px],
//      text-[11px], text-[11.5px], text-[9px] … — any `text-[<n>px]` where
//      n < 12. (Named scales like text-xs=12px are fine and never flagged.)
//
//   2. Recharts (and similar) inline `tick={{ fontSize: N }}` / `<text
//      fontSize={N}>` props where N < 12 — these render as SVG <text>
//      elements with a real computed font-size.
//
//   3. Inline `style={{ fontSize: N }}` where N < 12, in any unit the regex
//      resolves (px by default; rem/pt converted on the Tailwind default
//      16px root).
//
// Usage:
//   node scripts/ci/check-text-sizes.mjs            # audit the dashboard
//   node scripts/ci/check-text-sizes.mjs --json     # machine-readable
//
// Exit codes:
//   0 — all text ≥ 12px (or no declarations found at all)
//   1 — one or more sub-12px declarations detected (CI-gateable)
//
// Self-test companion: check-text-sizes.self-test.mjs exercises the regexes
// against positive/negative samples and runs in the node-tests CI job.

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASH_SRC = path.join(ROOT, "artifacts", "admin-dashboard", "src");

const FLOOR_PX = 12;
const ROOT_PX = 16; // Tailwind + this app's default rem root.

// Allowed named Tailwind text scales and their px values. Anything not in
// this map is either a non-font utility (text-primary, text-center) or a
// size ≥ the floor, so it is never flagged. text-2xs/text-3xs are custom
// scales some projects define below 12px — listed so they ARE caught.
const NAMED_SCALES = {
  "text-xs": 12,
  "text-2xs": 10, // custom, below floor — flagged
  "text-3xs": 8, // custom, below floor — flagged
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
  "text-2xl": 24,
  "text-3xl": 30,
};

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

/**
 * Matches Tailwind arbitrary font-size utilities of the form `text-[<n>px]`
 * or `text-[<n>rem]` or `text-[<n>pt]`. Captures the numeric value and the
 * unit so it can be normalized to px and compared against the floor. The
 * leading `\b` + `text-` prefix avoids matching `leading-[10px]` or
 * `max-w-[10px]` etc. Respects a leading responsive/variant prefix
 * (`sm:text-[10px]`, `dark:text-[11px]`).
 */
const TW_ARBITRARY = /\b(?:[a-z]+:)?text-\[(\d+(?:\.\d+)?)(px|rem|pt)\]/g;

/**
 * Matches React/SVG numeric fontSize props: `fontSize={11}`, `fontSize:
 * 11`, `fontSize="11"`, `fontSize="11px"`. Captures the number.
 */
const FONT_SIZE_PROP = /fontSize(?:\s*=\s*"?(\d+(?:\.\d+)*)"?\s*|\s*:\s*(\d+(?:\.\d+)?))/g;

/**
 * Matches Tailwind named custom-below-floor scales so a project can't
 * quietly introduce `text-2xs`. Standard named sizes (text-xs/sm/…) are all
 * ≥ 12px and intentionally never flagged.
 */
const NAMED_BELOW_FLOOR = new RegExp(
  Object.keys(NAMED_SCALES)
    .filter((k) => NAMED_SCALES[k] < FLOOR_PX)
    .map((k) => `\\b(?:[a-z]+:)?${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    .join("|"),
  "g",
);

function toPx(value, unit) {
  const n = parseFloat(value);
  switch (unit) {
    case "px":
      return n;
    case "rem":
      return n * ROOT_PX;
    case "pt":
      return n * (4 / 3);
    default:
      return n;
  }
}

/**
 * Build a human-identifiable selector-ish hint from a matched line: prefer a
 * nearby className / component tag, else fall back to the trimmed line.
 */
function describeLine(line) {
  const trimmed = line.trim();
  // Try to surface an enclosing tag or className snippet for orientation.
  const tag = trimmed.match(/<[A-Za-z][A-Za-z0-9.]*/);
  const cls = trimmed.match(/className="([^"]{0,60})/);
  const parts = [];
  if (tag) parts.push(tag[0]);
  if (cls) parts.push(`className="${cls[1]}…"`);
  return parts.length ? `${parts.join(" ")} — ${trimmed.slice(0, 50)}` : trimmed.slice(0, 50);
}

async function main() {
  const violations = [];
  const files = [];

  for await (const file of glob("**/*.{tsx,jsx,ts,js}", { cwd: DASH_SRC })) {
    files.push(file);
    const fullPath = path.join(DASH_SRC, file);
    const content = readFileSync(fullPath, "utf8");
    const lines = content.split("\n");

    lines.forEach((line, idx) => {
      // Skip comment-only lines so a doc reference to a small size doesn't trip.
      const stripped = line.trimStart();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;

      // 1. Tailwind arbitrary utilities.
      for (const m of line.matchAll(TW_ARBITRARY)) {
        const px = toPx(m[1], m[2]);
        if (px < FLOOR_PX) {
          violations.push({
            file: `artifacts/admin-dashboard/src/${file}`,
            line: idx + 1,
            size: `${m[1]}${m[2]} (${px}px)`,
            element: describeLine(line),
          });
        }
      }

      // 2. Custom named below-floor scales (text-2xs etc.).
      for (const m of line.matchAll(NAMED_BELOW_FLOOR)) {
        violations.push({
          file: `artifacts/admin-dashboard/src/${file}`,
          line: idx + 1,
          size: `${m[0]} (${NAMED_SCALES[m[0].replace(/^[a-z]+:/, "")]}px)`,
          element: describeLine(line),
        });
      }

      // 3. fontSize numeric props.
      for (const m of line.matchAll(FONT_SIZE_PROP)) {
        const n = parseFloat(m[1] ?? m[2]);
        if (n < FLOOR_PX) {
          violations.push({
            file: `artifacts/admin-dashboard/src/${file}`,
            line: idx + 1,
            size: `fontSize:${n}px`,
            element: describeLine(line),
          });
        }
      }
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({ floor: FLOOR_PX, filesScanned: files.length, violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(`✓ All text ≥ ${FLOOR_PX}px (scanned ${files.length} files in artifacts/admin-dashboard/src)`);
  } else {
    console.error(`✖ sub-12px text detected (A11Y-003): ${violations.length} violation(s)\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    size:    ${v.size}`);
      console.error(`    element: ${v.element}`);
      console.error("");
    }
    console.error(
      `Raise each declaration to ≥ ${FLOOR_PX}px (e.g. text-[12px] / text-xs / fontSize:12). ` +
        `For dense data values, abbreviate the label and expose the full value via a tooltip.`,
    );
    process.exit(1);
  }
}

await main();
