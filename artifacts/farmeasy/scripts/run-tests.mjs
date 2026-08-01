// Deterministic Node test runner for @workspace/farmeasy.
//
// Discovers every `**/*.test.ts` below this package — including `utils/` pure
// logic tests today and planned `hooks/` tests — using `node:fs/promises.glob`
// rather than shell `**` expansion (unordered + version-dependent). Sorts the
// paths so execution order is stable across runs/shells/CI, prints the
// discovered count, and fails closed when zero files match.
//
// FarmEasy tests are pure logic (no DB/network), so no concurrency pin is
// needed.
//
// Run with:  pnpm --filter @workspace/farmeasy run test
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");

// Collect every TypeScript test file below the package, including utils/ and
// planned hooks/. `exclude` keeps node_modules, build output, and the Expo
// .expo cache out of discovery.
const discovered = [];
for await (const entry of glob("**/*.test.ts", {
  cwd: pkgRoot,
  exclude: (name) =>
    name === "node_modules" || name === "dist" || name === ".expo",
})) {
  discovered.push(entry);
}

// Stable ordering: deterministic test execution across environments.
const testFiles = discovered.sort();
const count = testFiles.length;

console.log(`[farmeasy] discovered ${count} test file(s):`);
for (const f of testFiles) console.log(`  - ${relative(pkgRoot, f) || f}`);

if (count === 0) {
  console.error("[farmeasy] no test files matched `**/*.test.ts` — failing closed");
  process.exit(1);
}

// `node --import tsx/esm --test <files>` hits Node's ERR_REQUIRE_CYCLE_MODULE
// on Node 22+ when the test runner's internal file-loading require()'s an ESM
// module in a cycle through the tsx/esm loader hooks. tsx's own `--test` CLI
// wrapper (which still runs on node:test under the hood) does not hit this —
// verified locally on Node 26.4.0 and matches the pinned CI Node 22.23.2.
// --experimental-test-module-mocks: hooks/*.test.ts mocks `@/lib/supabase`
// via node:test's mock.module(), which is gated behind this flag.
const args = ["--test", "--experimental-test-module-mocks", ...testFiles];
const child = spawn(tsxBin, args, { stdio: "inherit", cwd: pkgRoot });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
