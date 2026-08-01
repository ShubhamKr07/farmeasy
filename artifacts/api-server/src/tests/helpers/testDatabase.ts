import { after, before } from "node:test";
import { sql } from "drizzle-orm";

/**
 * TEST_DATABASE_URL gate, mirroring src/tests/metrics/parity.test.ts:
 * hard-fail only when REQUIRE_TEST_DATABASE=true, otherwise return the URL
 * (or undefined) so the caller can skip its suite. Callers wrap their
 * describe in `{ skip: !requireTestDatabaseUrl() }` — the same convention the
 * metrics suites use — so the local node:test job stays green without a
 * database.
 */
export function requireTestDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (process.env.REQUIRE_TEST_DATABASE === "true" && !url) {
    throw new Error(
      "TEST_DATABASE_URL is required when REQUIRE_TEST_DATABASE=true",
    );
  }
  return url;
}

export interface TestDatabaseHandle {
  /** TEST_DATABASE_URL (or undefined). Use to gate `describe(..., { skip })`. */
  readonly url: string | undefined;
  /**
   * The drizzle `db` instance, populated by the `before` hook. `undefined`
   * when the suite is skipped (no TEST_DATABASE_URL) — tests inside a
   * skipped describe never read it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

/**
 * Serial database fixture for DB-backed route suites (Tasks 5-9).
 *
 * In `before`: set `DATABASE_URL` to the test database, lazily import
 * `@workspace/db` (so its module-level `Pool` opens against
 * TEST_DATABASE_URL rather than whatever DATABASE_URL the process started
 * with — lib/db/src/index.ts reads it at load), then TRUNCATE *only* the
 * caller-named tables. Never the whole DB, so unrelated reference data
 * (seed lots, growth profiles, facilities, ...) can survive across suites
 * when a test wants it to.
 *
 * In `after`: close the shared `pool` exported by `@workspace/db` so the
 * node:test process exits instead of hanging on a dangling connection.
 *
 * Must be called inside a `describe` scope (it registers node:test hooks).
 * Use one fixture per test file — the node:test runner isolates each file in
 * its own process, so this owns that file's single pool. Gate the describe
 * with `{ skip: !handle.url }`; the hooks are also internally guarded, so an
 * unconfigured run is a safe no-op (no error, no hang).
 *
 * Table names are interpolated as raw SQL identifiers — pass only trusted,
 * literal table names (never request-derived input). They are double-quoted
 * so the truncate is scoped to exactly the named tables.
 */
export function useDatabaseFixture(
  tables: readonly string[],
): TestDatabaseHandle {
  const handle: TestDatabaseHandle = {
    url: process.env.TEST_DATABASE_URL,
    db: undefined,
  };

  before(async () => {
    if (!handle.url) return;
    // Point the db package at the test database BEFORE its module-level Pool
    // is constructed on first import.
    process.env.DATABASE_URL = handle.url;
    const mod = await import("@workspace/db");
    handle.db = mod.db;
    if (tables.length > 0) {
      const list = tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(", ");
      await handle.db.execute(
        sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
      );
    }
  });

  after(async () => {
    if (!handle.url) return;
    // Same cached module as `before` — closes the pool we actually opened.
    const mod = await import("@workspace/db");
    await mod.pool.end();
  });

  return handle;
}
