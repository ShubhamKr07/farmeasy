import { after, before, beforeEach } from "node:test";
import { sql } from "drizzle-orm";

/**
 * Seeds a matching `auth.users` row for a synthetic test-user id, then
 * upserts the `public.users` row with the given role/organization.
 *
 * `public.users.id` has a foreign key to `auth.users.id`
 * (00004_create_auth_profiles.sql, `users_id_auth_users_id_fk`) — a plain
 * `db.insert(usersTable)` with a synthetic id (never real Supabase auth
 * signup) violates it. Inserting into `auth.users` first also fires
 * `handle_new_user()` (AFTER INSERT trigger), which auto-creates the
 * `public.users` row itself (role: technician, no organization) — hence the
 * upsert below rather than a plain insert, which would otherwise collide
 * with the trigger's own row. `ON CONFLICT DO NOTHING` on the auth.users
 * insert makes this safe to call from every test file/setup() that needs a
 * signed-in test user, even when auth.users already has the row from an
 * earlier test in the same file (only `public.users` is truncated between
 * tests, not `auth.users` — see useDatabaseFixture below).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedTestUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usersTable: any,
  user: { id: string; email: string; role?: string; organizationId?: number | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (${user.id}, 'authenticated', 'authenticated', ${user.email}, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await db
    .insert(usersTable)
    .values({
      id: user.id,
      email: user.email,
      role: user.role ?? "technician",
      organizationId: user.organizationId ?? null,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { role: user.role ?? "technician", organizationId: user.organizationId ?? null },
    });
}

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
 * In `beforeEach`: re-truncate the same named tables before every test, not
 * just once for the whole file. Without this, tests that insert their own
 * fixture rows accumulate state across each other within a file (node:test's
 * `before` runs once per describe, not per test) — count-based assertions
 * become order-dependent. Caught for real running Task 6's route suite
 * against the disposable Supabase stack: status=done saw 2 rows instead of
 * 1, carried over from an earlier test's insert in the same file.
 *
 * Does NOT close the shared `pool` itself — see `closeDatabasePoolAfterTests`
 * below. A file may call `useDatabaseFixture` from more than one `describe`
 * block (each with its own truncate-table list); closing the pool inside
 * this function's own `after()` would tear it down once the FIRST describe
 * block's tests finish, before any later describe block's `before()`/
 * `beforeEach()` ever runs its own query against it.
 *
 * Must be called inside a `describe` scope (it registers node:test hooks).
 * Gate the describe with `{ skip: !handle.url }`; the hooks are also
 * internally guarded, so an unconfigured run is a safe no-op (no error, no
 * hang).
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

  const truncateTables = async () => {
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(", ");
    await handle.db.execute(
      sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
    );
  };

  before(async () => {
    if (!handle.url) return;
    // Point the db package at the test database BEFORE its module-level Pool
    // is constructed on first import.
    process.env.DATABASE_URL = handle.url;
    const mod = await import("@workspace/db");
    handle.db = mod.db;
    await truncateTables();
  });

  beforeEach(async () => {
    if (!handle.url) return;
    await truncateTables();
  });

  return handle;
}

/**
 * Closes the shared `@workspace/db` pool so the node:test process exits
 * instead of hanging on a dangling connection. Call this ONCE per test file,
 * in a top-level `after()` outside every `describe` block — never inside
 * one (see `useDatabaseFixture`'s doc comment for why: a describe-scoped
 * close would fire before a later sibling describe block's own fixture
 * hooks run, breaking every describe after the first in a multi-describe
 * file — caught for real running this suite's CI job against the disposable
 * Supabase stack, where every describe after the first failed with "Cannot
 * use a pool after calling end").
 */
export function closeDatabasePoolAfterTests(): void {
  after(async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const mod = await import("@workspace/db");
    await mod.pool.end();
  });
}
