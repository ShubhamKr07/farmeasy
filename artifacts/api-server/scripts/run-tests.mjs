// Deterministic Node test runner for @workspace/api-server.
//
// Discovers every `**/*.test.ts` below this package (src/, lib/, etc.) using
// `node:fs/promises.glob` — never shell `**` expansion, which is unordered and
// version-dependent. Sorts the collected paths so test ordering is stable
// across runs/shells/CI, prints the discovered count, and fails closed when
// zero test files are found (catches broken globs silently passing).
//
// DB-backed suites live under src/tests/metrics and are gated on
// TEST_DATABASE_URL; they skip unless that env var is set, so the local
// `test:node` job stays green without a database.
//
// Run with:  pnpm --filter @workspace/api-server run test
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

// Collect every TypeScript test file below the package. `exclude` keeps node
//_modules and build output out of the discovery set.
const discovered = [];
for await (const entry of glob("**/*.test.ts", {
  cwd: pkgRoot,
  exclude: (name) => name === "node_modules" || name === "dist",
})) {
  discovered.push(entry);
}

// Stable ordering: deterministic test execution across environments.
const testFiles = discovered.sort();
const count = testFiles.length;

console.log(`[api-server] discovered ${count} test file(s):`);
for (const f of testFiles) console.log(`  - ${relative(pkgRoot, f) || f}`);

if (count === 0) {
  console.error("[api-server] no test files matched `**/*.test.ts` — failing closed");
  process.exit(1);
}

// --test-concurrency=1 keeps DB-backed suites from interleaving a shared
// connection when TEST_DATABASE_URL is provided.
const args = ["--import", "tsx/esm", "--test", "--test-concurrency=1", ...testFiles];
const child = spawn(process.execPath, args, { stdio: "inherit", cwd: pkgRoot });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
