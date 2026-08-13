// scripts/ci/check-metric-heights.mjs
// Overview grid height contract guard (OVW-001/002).
//
// Fails CI if any file under
//   artifacts/admin-dashboard/src/components/metrics/
// reintroduces a fixed Tailwind pixel height — the `h-[…px]` / `max-h-[…px]`
// arbitrary-value pattern. The height contract is enforced by CSS grid
// primitives instead (DraggableMetricGrid sets grid-auto-rows + items-stretch;
// card roots use h-full and flex column bodies that grow to fill the row), so
// a fixed pixel height anywhere in a metric card breaks the contract by
// pinning one card to a height its row-mates can no longer match. This check
// is the "lint bans fixed pixel heights in metric components" rule the
// mockup (frame 2d) and plan call for.
//
// This repo has no ESLint — this is a hand-written check matching the
// check-tenant-scope.mjs / check-dependency-audit.mjs pattern (same node +
// fs/glob usage, same exit-code convention). Run it directly or via the CI
// quality job (.github/workflows/ci.yml).
//
// Only the arbitrary-VALUE form is banned (`h-[200px]`, `h-[100px]`,
// `max-h-[240px]`). Named Tailwind utilities (`h-full`, `h-8`, `h-3.5`,
// `min-h-48`, `min-h-0`) and the spacing-scale arbitrary form are NOT banned —
// they're the contract's building blocks. The regex anchors on a length unit
// (px) inside the bracket so it never matches a non-height arbitrary value.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const METRICS_DIR = path.join(
  ROOT,
  "artifacts/admin-dashboard/src/components/metrics",
);

// Matches `h-[<digits>px]` and `max-h-[<digits>px]` (and `min-h-[…px]`, though
// the contract uses `min-h-<scale>` there). Backslash-escapes the `[` so it's
// a literal bracket; the capture inside is digit(s) followed by `px`. Works
// whether the class is the only token or sits among others (it scans the whole
// file, so it catches multi-class strings like
//   "divide-y divide-border rounded-md border overflow-hidden max-h-[240px]"
// which is exactly how these slipped in originally).
const FIXED_PX_HEIGHT = /\b(?:max-|min-)?h-\[\d+px\]/g;

const violations = [];

for await (const file of glob("**/*.{ts,tsx}", { cwd: METRICS_DIR })) {
  const fullPath = path.join(METRICS_DIR, file);
  const relPath = path.relative(ROOT, fullPath);
  const content = readFileSync(fullPath, "utf8");

  for (const match of content.matchAll(FIXED_PX_HEIGHT)) {
    const upToMatch = content.slice(0, match.index);
    const lineNumber = upToMatch.split("\n").length;
    violations.push(`${relPath}:${lineNumber}: ${match[0]}`);
  }
}

if (violations.length > 0) {
  console.error(
    "Fixed-pixel heights (`h-[…px]` / `max-h-[…px]`) found in metric components —\n" +
      "these break the overview grid height contract (OVW-001/002). Use the CSS\n" +
      "grid contract instead: card root `h-full flex flex-col`, body `flex-1\n" +
      "flex flex-col`, chart regions `flex-1 min-h-<scale>`. See\n" +
      "DraggableMetricGrid.tsx's header comment.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\n${violations.length} violation(s). Replace each with the flex/` +
      "grid-based contract (or a named Tailwind spacing utility).",
  );
  process.exit(1);
}

console.log(
  "check-metric-heights: clean (0 fixed-pixel heights in metric components — " +
    "overview grid height contract holds)",
);
