// TEN-012 Task 8: unverified-account purge job.
//
// These tests drive the REAL disposable Supabase GoTrue (the same instance
// TEST_DATABASE_URL points at) rather than stubbing the admin API, so the
// enumeration + `email_confirmed_at` semantics are exercised for real (see the
// Task-6 note in supabaseAuth.ts: verification lives on the admin user
// object's `email_confirmed_at`, not the JWT). Account age is simulated by
// injecting `now` — every user is created "now" in GoTrue, so passing
// `now = Date.now() + Nd` makes a fresh user N days old.
//
// The purge scan is inherently GLOBAL (it pages through every auth user), so
// assertions key off the SPECIFIC users each test creates (getUserById, that
// user's audit rows, that user's org) — never off aggregate counts, which
// would be polluted by users left over from sibling tests or earlier runs.
//
// `account_purge_audit` is truncated before each test (useDatabaseFixture) for
// warn-dedup isolation. Auth users are best-effort deleted in after() so
// repeated local runs against the persistent disposable stack don't leak.
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  useDatabaseFixture,
  requireTestDatabaseUrl,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase.js";

const dbUrl = requireTestDatabaseUrl();
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(dbUrl && supabaseUrl && serviceKey);

closeDatabasePoolAfterTests();

const DAY_MS = 24 * 60 * 60 * 1000;

describe("purgeUnverifiedAccounts", { skip: !canRun }, () => {
  // Truncated before each test so warn-dedup starts clean per case.
  useDatabaseFixture(["account_purge_audit"]);

  const createdUserIds: string[] = [];
  // Recording stub injected as `sendWarning`.
  const warnedEmails: string[] = [];
  const sendWarning = async ({ to }: { to: string }): Promise<void> => {
    warnedEmails.push(to);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let purgeUnverifiedAccounts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbmod: any;

  before(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    admin = createClient(supabaseUrl!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // Imported lazily: both pull @workspace/db, whose module-level Pool must
    // bind to TEST_DATABASE_URL — useDatabaseFixture's own before() (registered
    // first) has set DATABASE_URL by the time this runs.
    purgeUnverifiedAccounts = (await import("../../lib/purgeUnverified.js")).purgeUnverifiedAccounts;
    dbmod = await import("@workspace/db");
  });

  beforeEach(() => {
    warnedEmails.length = 0;
  });

  after(async () => {
    if (!admin) return;
    for (const id of createdUserIds) {
      // Best-effort — a failed cleanup delete must never fail the suite.
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  async function createUser(confirmed: boolean): Promise<{ id: string; email: string }> {
    const email = `purge-test-${randomUUID()}@purge-test.example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: `Test-${randomUUID()}!Aa1`,
      email_confirm: confirmed,
    });
    if (error || !data?.user) {
      throw new Error(`createUser failed: ${error?.message}`);
    }
    createdUserIds.push(data.user.id);
    return { id: data.user.id, email };
  }

  async function seedOwnerOrg(
    userId: string,
    opts: { withFacility: boolean },
  ): Promise<number> {
    const db = dbmod.db;
    const { organizationsTable, organizationMembersTable, facilitiesTable } = dbmod;
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Purge Org ${randomUUID()}` })
      .returning();
    await db.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId,
      role: "owner",
      status: "active",
    });
    if (opts.withFacility) {
      await db.insert(facilitiesTable).values({
        name: "Purge Facility",
        organizationId: org.id,
        facilityName: "Main",
        timezone: "UTC",
      });
    }
    return org.id;
  }

  async function userExists(id: string): Promise<boolean> {
    const { data, error } = await admin.auth.admin.getUserById(id);
    return Boolean(!error && data?.user);
  }

  async function auditRows(userId: string, action: string): Promise<unknown[]> {
    const { accountPurgeAuditTable } = dbmod;
    return dbmod.db
      .select()
      .from(accountPurgeAuditTable)
      .where(
        and(
          eq(accountPurgeAuditTable.userId, userId),
          eq(accountPurgeAuditTable.action, action),
        ),
      );
  }

  async function orgExists(orgId: number): Promise<boolean> {
    const { organizationsTable } = dbmod;
    const rows = await dbmod.db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    return rows.length > 0;
  }

  test("spares a verified user regardless of age", async () => {
    const user = await createUser(true);
    const now = new Date(Date.now() + 31 * DAY_MS);

    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.ok(await userExists(user.id), "verified user must NOT be deleted");
    assert.equal(warnedEmails.includes(user.email), false, "verified user must not be warned");
    assert.equal((await auditRows(user.id, "purged")).length, 0, "no purged audit for verified user");
  });

  test("spares an unverified user younger than 7 days and does not warn", async () => {
    const user = await createUser(false);
    // ~3 days old.
    const now = new Date(Date.now() + 3 * DAY_MS);

    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.ok(await userExists(user.id), "young unverified user must be spared");
    assert.equal(warnedEmails.includes(user.email), false, "must not warn a <7d account");
    assert.equal((await auditRows(user.id, "warned")).length, 0, "no warned audit for a <7d account");
  });

  test("warns an unverified user aged 7-10 days exactly once (never twice)", async () => {
    const user = await createUser(false);
    // ~8 days old — in the [7, 10) warn window.
    const now = new Date(Date.now() + 8 * DAY_MS);

    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.equal(warnedEmails.includes(user.email), true, "must warn an 8d account");
    assert.equal((await auditRows(user.id, "warned")).length, 1, "exactly one warned audit row");
    assert.ok(await userExists(user.id), "warned user is not deleted");

    // Second run must NOT warn again (prior 'warned' audit exists).
    warnedEmails.length = 0;
    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.equal(warnedEmails.includes(user.email), false, "must never warn the same account twice");
    assert.equal((await auditRows(user.id, "warned")).length, 1, "still exactly one warned audit row");
  });

  test("purges an unverified user >=10 days whose owner org has no facilities", async () => {
    const user = await createUser(false);
    const orgId = await seedOwnerOrg(user.id, { withFacility: false });
    const now = new Date(Date.now() + 11 * DAY_MS);

    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.equal(await userExists(user.id), false, "auth user must be deleted");
    assert.equal(await orgExists(orgId), false, "data-less owner org row must be deleted");
    assert.equal((await auditRows(user.id, "purged")).length, 1, "a purged audit row must be written");
  });

  test("does NOT purge an unverified user >=10 days whose owner org has a facility", async () => {
    const user = await createUser(false);
    const orgId = await seedOwnerOrg(user.id, { withFacility: true });
    const now = new Date(Date.now() + 11 * DAY_MS);

    await purgeUnverifiedAccounts({ now, admin, sendWarning });

    assert.ok(await userExists(user.id), "user with real data must NOT be deleted");
    assert.ok(await orgExists(orgId), "org with a facility must NOT be deleted");
    assert.equal((await auditRows(user.id, "purged")).length, 0, "no purged audit when data is present");
  });
});
