// scripts/ci/check-a11y-regression.mjs
//
// A11Y Regression Guard: viewport zoom lock + text-size floor (A11Y-002/003).
//
// Composite check that:
// 1. Verifies viewport meta does NOT have maximum-scale or user-scalable=no
//    (A11Y-002: "restore pinch-zoom")
// 2. Runs the font-size audit (A11Y-003: text-size floor ≥ 12px)
//
// Exit codes:
//   0 — both checks pass (zoom is permissive, all text ≥ 12px)
//   1 — either check fails (CI-gateable)
//
// Usage: node scripts/ci/check-a11y-regression.mjs

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = path.join(ROOT, "artifacts", "admin-dashboard", "index.html");

let passed = true;

// ── Check 1: Viewport meta must not have maximum-scale or user-scalable=no ──
console.log("A11Y Regression Guard: Checking viewport meta zoom lock...");
try {
  const html = readFileSync(INDEX_HTML, "utf8");
  const viewportMeta = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);

  if (!viewportMeta) {
    console.error("✖ No viewport meta found in index.html");
    passed = false;
  } else {
    const content = viewportMeta[1];
    if (content.includes("maximum-scale") || content.includes("user-scalable=no")) {
      console.error(`✖ viewport meta has zoom lock (A11Y-002)\n  content="${content}"`);
      console.error('  Fix: Remove "maximum-scale" and "user-scalable=no" from viewport meta');
      passed = false;
    } else {
      console.log(`✓ Viewport meta is zoom-permissive: "${content}"`);
    }
  }
} catch (err) {
  console.error(`✖ Failed to read index.html: ${err.message}`);
  passed = false;
}

// ── Check 2: Font-size audit (A11Y-003) ──
console.log("\nA11Y Regression Guard: Checking font-size floor (≥ 12px)...");
try {
  execSync("node scripts/ci/check-text-sizes.mjs", {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log("✓ Font-size floor check passed");
} catch (err) {
  console.error("✖ Font-size floor check failed (A11Y-003)");
  passed = false;
}

// ── Summary ──
console.log("\n" + "=".repeat(60));
if (passed) {
  console.log("✓ A11Y Regression Guard: ALL CHECKS PASSED");
  process.exit(0);
} else {
  console.log("✖ A11Y Regression Guard: ONE OR MORE CHECKS FAILED");
  console.log("\nFix the issues above and re-run: node scripts/ci/check-a11y-regression.mjs");
  process.exit(1);
}
