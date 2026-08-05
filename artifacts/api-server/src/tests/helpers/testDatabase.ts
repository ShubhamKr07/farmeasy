import { after, before, beforeEach } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { buildSslConfig } from "@workspace/db/ssl";
import * as schema from "@workspace/db/schema";

const { Pool } = pg;

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
  // Writing directly to auth.users (Supabase Auth's own schema, normally
  // populated only via real signup) needs the same elevated access as
  // truncation — a least-privilege app role has no business writing there in
  // production, so this test shortcut uses the admin connection when one is
  // configured (see getAdminPool's doc comment above useDatabaseFixture).
  const admin = getAdminPool();
  if (admin) {
    await admin.query(
      `INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.email],
    );
  } else {
    await db.execute(sql`
      INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES (${user.id}, 'authenticated', 'authenticated', ${user.email}, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  // Real signup always goes through the handle_new_user() SECURITY DEFINER
  // trigger (00004) -- it runs as the trigger's owner regardless of caller,
  // never through the app's own connection. This upsert's INSERT branch
  // (when no row exists yet -- e.g. right after truncating public.users, or
  // a genuinely first-time synthetic id) is purely this test helper standing
  // in for that trigger, so it needs the same admin routing as the
  // auth.users insert above; the UPDATE branch (00009) is what a real
  // farmsmart_app connection is actually expected to do.
  await (getAdminDb() ?? db)
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
 * Seeds a full tenant context for a synthetic test-user id: the `auth.users`
 * + `public.users` rows (via seedTestUser), an `organizations` row, a
 * `facilities` row linked to that org, and an `organization_members` row
 * (status: active) linking the user to the org. This is exactly what
 * resolveTenantContext (middlewares/tenantContext.ts) joins on to populate
 * `req.tenant` { organizationId, facilityId, role }, which the
 * withTenantScope-rewired routes (alerts/tasks/shipments) require.
 *
 * Returns the created { organizationId, facilityId } so the caller can scope
 * its own fixture inserts to the same facilityId the request will be filtered
 * by (the route's eq(table.facilityId, req.tenant!.facilityId)).
 *
 * `organizations`/`facilities`/`organization_members` are shared reference
 * tables (never truncated by these suites' fixtures — see useDatabaseFixture),
 * so each call creates its own fresh rows and assertions key off the returned
 * ids rather than off the tables being globally empty. The
 * `organization_members.user_id` unique index means a second call for the
 * same userId (e.g. across describe blocks) upserts the membership onto the
 * new org — never a duplicate, never a stale-org leak.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedTenantContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: {
    usersTable: any;
    organizationsTable: any;
    facilitiesTable: any;
    organizationMembersTable: any;
  },
  user: { id: string; email: string; role?: string },
  options: { farmName?: string; facilityName?: string; timezone?: string; memberRole?: "owner" | "admin" | "technician" } = {},
): Promise<{ organizationId: number; facilityId: number }> {
  await seedTestUser(db, schema.usersTable, { ...user, organizationId: null });

  const [org] = await db
    .insert(schema.organizationsTable)
    .values({ name: options.farmName ?? "Test Farm" })
    .returning();

  const [facility] = await db
    .insert(schema.facilitiesTable)
    .values({
      name: options.farmName ?? "Test Farm",
      organizationId: org.id,
      facilityName: options.facilityName ?? "Main Facility",
      timezone: options.timezone ?? "UTC",
    })
    .returning();

  // Real app code (facilities.ts POST /facilities) only ever plain-INSERTs a
  // membership row once per user -- farmsmart_app's RLS policy (00011) is
  // INSERT-only, matching that. This helper's onConflictDoUpdate exists
  // purely so a test file can call seedTenantContext multiple times for the
  // SAME synthetic user across different test cases (upserting onto a new
  // org each time) -- that UPDATE path has no real-app equivalent, so route
  // it through the admin connection like the other test-only elevated needs
  // above, rather than adding a farmsmart_app UPDATE policy production would
  // never use.
  const memberRole = options.memberRole ?? "technician";
  const admin = getAdminPool();
  if (admin) {
    await admin.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id) DO UPDATE SET organization_id = $1, role = $3, status = 'active'`,
      [org.id, user.id, memberRole],
    );
    return { organizationId: org.id, facilityId: facility.id };
  }
  await db
    .insert(schema.organizationMembersTable)
    .values({
      organizationId: org.id,
      userId: user.id,
      role: memberRole,
      status: "active",
    })
    .onConflictDoUpdate({
      target: schema.organizationMembersTable.userId,
      set: {
        organizationId: org.id,
        role: memberRole,
        status: "active",
      },
    });

  return { organizationId: org.id, facilityId: facility.id };
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

/**
 * `TRUNCATE ... RESTART IDENTITY` requires ownership of the table/sequence,
 * not just DML grants — a least-privilege app role (e.g. MT-M1's
 * `farmsmart_app`, which only gets SELECT/INSERT/UPDATE/DELETE) can never
 * satisfy it. Rather than granting the app role ownership (which would
 * bypass its own privilege checks and defeat the point of verifying it),
 * `TEST_ADMIN_DATABASE_URL` lets the truncate step run over a *separate*
 * elevated connection while the app-under-test and every other query in this
 * file keep using `TEST_DATABASE_URL`/`handle.db` as before. Unset in every
 * existing CI/local run (disposable stack's connection is already
 * superuser), so this is a no-op there — `truncateTables` falls back to
 * `handle.db` exactly as before.
 */
let adminPool: pg.Pool | undefined;

function getAdminPool(): pg.Pool | undefined {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) return undefined;
  if (!adminPool) {
    adminPool = new Pool({ connectionString: adminUrl, ssl: buildSslConfig(adminUrl) });
  }
  return adminPool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminDb: any;

/**
 * A drizzle instance over the same admin connection as getAdminPool, for
 * test files that seed tenant-scoped table rows directly (not through a real
 * HTTP request against a withTenantScope-wired route) -- those direct
 * inserts never have app.facility_id/app.org_id set, so 00007's tenant-
 * isolation policies reject them under farmsmart_app. Real app code never
 * hits this path (it always goes through withTenantScope), so bypassing RLS
 * for this fixture-seeding is safe and matches the same test-only-need
 * pattern as truncateTables/seedTestUser/seedTenantContext above. Returns
 * undefined when TEST_ADMIN_DATABASE_URL is unset (every existing CI/local
 * run) -- callers do `(getAdminDb() ?? db).insert(...)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAdminDb(): any {
  const pool = getAdminPool();
  if (!pool) return undefined;
  if (!adminDb) {
    adminDb = drizzle(pool, { schema });
  }
  return adminDb;
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
    const admin = getAdminPool();
    if (admin) {
      await admin.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    } else {
      await handle.db.execute(
        sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
      );
    }
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
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  });
}
