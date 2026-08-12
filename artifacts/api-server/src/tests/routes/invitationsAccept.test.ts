import { describe, test, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

/**
 * POST /invitations/accept — invite-acceptance flow (TEN-010 Task 6).
 *
 * This router is deliberately UNGATED (no session/tenant/role — the invitee
 * may not be a member yet), unlike invitations.ts's owner/admin-gated
 * routes. It's mounted on a separate router; see invitationsAccept.ts's own
 * top comment.
 *
 * Gated on TEST_DATABASE_URL AND SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * (mirrors app.test.ts's `canRun`) because accept creates a REAL
 * `auth.users` row via `admin().auth.admin.createUser(...)` — that needs a
 * live Supabase Auth (GoTrue) server, not just Postgres. Every accept-flow
 * test uses a randomized email (`randomUUID()` local-part) so repeated runs
 * against the same persistent local disposable Supabase instance never
 * collide on `auth.users.email`'s implicit uniqueness, and every
 * `auth.users` row this file creates (directly or via the route) is deleted
 * in the top-level `after()` below so it doesn't leak across runs.
 */
const dbUrl = requireTestDatabaseUrl();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(dbUrl && supabaseUrl && supabaseServiceRoleKey);

closeDatabasePoolAfterTests();

describe("POST /invitations/accept", { skip: !canRun }, () => {
  const fixture = useDatabaseFixture(["invitations"]);

  // auth.users ids created over the course of this file (by the route's own
  // admin.auth.admin.createUser call, or directly by seedTenantContext's
  // seedTestUser helper) — deleted via the admin API below so they don't
  // accumulate in the persistent local disposable Supabase instance across
  // repeated runs.
  const createdAuthUserIds: string[] = [];

  after(async () => {
    if (!canRun) return;
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(supabaseUrl!, supabaseServiceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    for (const id of createdAuthUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => {
        // Best-effort cleanup only -- must never fail the suite.
      });
    }
  });

  // Fixed synthetic id for the invite's `invitedBy` — reused across every
  // test in this file the same way invitations.test.ts's DEFAULT_TEST_USER
  // is: organizations/facilities/organization_members/auth.users/public.users
  // are reference tables `useDatabaseFixture` never truncates, and
  // seedTenantContext's onConflictDoUpdate(target: userId) keeps re-seeding
  // idempotent across runs.
  const INVITER_ID = "00000000-0000-4000-8000-000000000010";

  async function setup() {
    const acceptRouter = (await import("../../routes/invitationsAccept")).default;
    const {
      db,
      usersTable,
      organizationsTable,
      facilitiesTable,
      organizationMembersTable,
      invitationsTable,
    } = await import("@workspace/db");
    const { organizationId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: INVITER_ID, email: "accept-inviter@example.com" },
      { memberRole: "owner", farmName: "Accept Test Farm" },
    );
    return {
      // Ungated router: no signed-in user is required for it to work, but
      // createAuthenticatedTestApp is still the right harness — it mirrors
      // app.ts's JSON body parsing / req.log wiring (see health.test.ts,
      // which uses it the same way for its own ungated /healthz route).
      app: createAuthenticatedTestApp(acceptRouter),
      db,
      invitationsTable,
      organizationMembersTable,
      usersTable,
      organizationId,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function seedInvite(
    db: any,
    invitationsTable: any,
    opts: {
      organizationId: number;
      email: string;
      role?: "admin" | "technician";
      status?: "pending" | "accepted" | "revoked" | "expired";
      expiresAt?: Date;
    },
  ): Promise<{ raw: string; id: number }> {
    const { generateInviteToken } = await import("../../lib/inviteToken");
    const { raw, hash } = generateInviteToken();
    const adminDb = getAdminDb() ?? db;
    const [row] = await adminDb
      .insert(invitationsTable)
      .values({
        organizationId: opts.organizationId,
        email: opts.email,
        role: opts.role ?? "technician",
        tokenHash: hash,
        status: opts.status ?? "pending",
        invitedBy: INVITER_ID,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();
    return { raw, id: row.id };
  }

  test("valid pending token + new email + password -> 201, creates auth user + active membership, invite marked accepted", async () => {
    const { app, db, invitationsTable, organizationMembersTable, usersTable, organizationId } =
      await setup();
    const email = `accept-new-${randomUUID()}@example.com`;
    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email,
      role: "technician",
    });

    const res = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(res.status, 201);
    strictEqual(res.body.email, email);
    strictEqual(res.body.role, "technician");
    strictEqual(res.body.organizationId, organizationId);

    const [userRow] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    ok(userRow, "public.users row should exist (handle_new_user trigger fired for the new auth.users row)");
    createdAuthUserIds.push(userRow.id);

    const [memberRow] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.userId, userRow.id),
          eq(organizationMembersTable.organizationId, organizationId),
        ),
      );
    ok(memberRow, "organization_members row should exist");
    strictEqual(memberRow.role, "technician");
    strictEqual(memberRow.status, "active");

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, email));
    strictEqual(inviteRow.status, "accepted");
  });

  test("second accept with the same token -> 400 (single-use)", async () => {
    const { app, db, invitationsTable, usersTable, organizationId } = await setup();
    const email = `accept-reuse-${randomUUID()}@example.com`;
    const { raw } = await seedInvite(db, invitationsTable, { organizationId, email });

    const first = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(first.status, 201);

    const [userRow] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    if (userRow) createdAuthUserIds.push(userRow.id);

    const second = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(second.status, 400);
  });

  test("expired token -> 400", async () => {
    const { app, db, invitationsTable, organizationId } = await setup();
    const email = `accept-expired-${randomUUID()}@example.com`;
    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(res.status, 400);

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, email));
    strictEqual(inviteRow.status, "expired", "an expired-but-pending invite must be marked expired, not left accepted");
  });

  test("revoked token -> 400", async () => {
    const { app, db, invitationsTable, organizationId } = await setup();
    const email = `accept-revoked-${randomUUID()}@example.com`;
    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email,
      status: "revoked",
    });

    const res = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(res.status, 400);
  });

  test("new email + no password -> 400, invite reverted to pending (no orphaned auth user)", async () => {
    const { app, db, invitationsTable, organizationId } = await setup();
    const email = `accept-nopass-${randomUUID()}@example.com`;
    const { raw } = await seedInvite(db, invitationsTable, { organizationId, email });

    // No `password` in the body: the handler claims the invite, discovers it
    // must create a brand-new auth user but has no password, and must revert
    // the claim rather than leave the invite burned.
    const res = await request(app).post("/api/invitations/accept").send({ token: raw });
    strictEqual(res.status, 400);

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, email));
    strictEqual(
      inviteRow.status,
      "pending",
      "a no-password accept for a new user must revert the claim so the invite is still usable",
    );
  });

  test("email already an active member of another org -> 400", async () => {
    const { app, db, invitationsTable, organizationId } = await setup();
    const { usersTable, organizationsTable, facilitiesTable, organizationMembersTable } =
      await import("@workspace/db");

    const existingEmail = `accept-existing-${randomUUID()}@example.com`;
    const existingUserId = randomUUID();
    await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: existingUserId, email: existingEmail },
      { memberRole: "technician", farmName: "Some Other Accept-Test Farm" },
    );
    createdAuthUserIds.push(existingUserId);

    // Invite this already-active-elsewhere email into a DIFFERENT org (the
    // one `setup()` created) to exercise the one-org-per-user guard.
    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email: existingEmail,
    });

    const res = await request(app)
      .post("/api/invitations/accept")
      .send({ token: raw, password: "Sup3rSecret!123" });
    strictEqual(res.status, 400);

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, existingEmail));
    strictEqual(
      inviteRow.status,
      "pending",
      "a rejected accept must revert the claim so the invite can still be used/reissued",
    );
  });

  test("existing Supabase user, no membership, accepts without a password -> 201, creates active membership", async () => {
    const { app, db, invitationsTable, organizationMembersTable, organizationId } = await setup();

    // Seed a real Supabase auth user directly (not via seedTenantContext, so
    // they have NO organization_members row yet -- exercising the
    // existing-user / no-password branch of the handler).
    const { createClient } = await import("@supabase/supabase-js");
    const adminClient = createClient(supabaseUrl!, supabaseServiceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `accept-existing-nopw-${randomUUID()}@example.com`;
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password: "Sup3rSecret!123",
      email_confirm: true,
    });
    ok(!error && data.user, "seed createUser should succeed");
    createdAuthUserIds.push(data.user!.id);

    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email,
      role: "admin",
    });

    const res = await request(app).post("/api/invitations/accept").send({ token: raw });
    strictEqual(res.status, 201);
    strictEqual(res.body.role, "admin");

    const [memberRow] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.userId, data.user!.id),
          eq(organizationMembersTable.organizationId, organizationId),
        ),
      );
    ok(memberRow, "organization_members row should exist");
    strictEqual(memberRow.role, "admin");
    strictEqual(memberRow.status, "active");

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, email));
    strictEqual(inviteRow.status, "accepted");
  });

  // TEN-011: invited users bypass the before_user_created hook entirely --
  // POST /invitations/accept creates the auth user via
  // `admin.auth.admin.createUser()` (service_role), which GoTrue does NOT
  // route through before_user_created (confirmed live -- see
  // 00025_signup_enforcement.sql's own header). This is the key regression
  // guard: with signup_config.mode='off' (the MOST restrictive setting --
  // fail-closed rejects every public /auth/v1/signup), an invite accept must
  // still succeed. Sets the row directly (admin connection, mirroring every
  // other elevated test-only write in this file) and restores it to 'off'
  // (the seeded default) afterward so this file never leaks a non-default
  // mode to a later test file.
  test("invite acceptance bypasses signup_config entirely -- succeeds even while mode='off'", async () => {
    const { app, db, invitationsTable, organizationMembersTable, usersTable, organizationId } =
      await setup();
    const { signupConfigTable } = await import("@workspace/db");
    const adminDb = getAdminDb() ?? db;

    await adminDb.update(signupConfigTable).set({ mode: "off" }).where(eq(signupConfigTable.id, 1));
    try {
      const email = `accept-bypass-off-${randomUUID()}@example.com`;
      const { raw } = await seedInvite(db, invitationsTable, {
        organizationId,
        email,
        role: "technician",
      });

      const res = await request(app)
        .post("/api/invitations/accept")
        .send({ token: raw, password: "Sup3rSecret!123" });
      strictEqual(res.status, 201, "invite accept must succeed regardless of signup_config.mode");
      strictEqual(res.body.email, email);

      const [userRow] = await db.select().from(usersTable).where(eq(usersTable.email, email));
      ok(userRow, "public.users row should exist (the invite path bypassed the hook and created a real auth user)");
      createdAuthUserIds.push(userRow.id);

      const [memberRow] = await db
        .select()
        .from(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.userId, userRow.id),
            eq(organizationMembersTable.organizationId, organizationId),
          ),
        );
      ok(memberRow, "organization_members row should exist");
      strictEqual(memberRow.status, "active");
    } finally {
      await adminDb.update(signupConfigTable).set({ mode: "off" }).where(eq(signupConfigTable.id, 1));
    }
  });

  test("re-join after removal: user with a removed membership accepts a fresh invite -> upsert reactivates them in the inviting org", async () => {
    const { app, db, invitationsTable, organizationMembersTable, organizationId } = await setup();
    const { usersTable, organizationsTable, facilitiesTable } = await import("@workspace/db");

    const email = `accept-rejoin-${randomUUID()}@example.com`;
    const userId = randomUUID();
    const { organizationId: otherOrgId } = await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: userId, email },
      { memberRole: "technician", farmName: "Removed-From Farm" },
    );
    createdAuthUserIds.push(userId);

    // Soft-remove their membership in the other org -- their organization_members
    // row still occupies the plain user_id unique index.
    await db
      .update(organizationMembersTable)
      .set({ status: "removed" })
      .where(
        and(
          eq(organizationMembersTable.userId, userId),
          eq(organizationMembersTable.organizationId, otherOrgId),
        ),
      );

    const { raw } = await seedInvite(db, invitationsTable, {
      organizationId,
      email,
      role: "technician",
    });

    const res = await request(app).post("/api/invitations/accept").send({ token: raw });
    strictEqual(res.status, 201);

    const memberRows = await db
      .select()
      .from(organizationMembersTable)
      .where(eq(organizationMembersTable.userId, userId));
    strictEqual(memberRows.length, 1, "exactly one organization_members row for this user");
    strictEqual(memberRows[0].status, "active");
    strictEqual(memberRows[0].organizationId, organizationId);

    const [inviteRow] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.email, email));
    strictEqual(inviteRow.status, "accepted");
  });
});
