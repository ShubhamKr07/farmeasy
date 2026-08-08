import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import {
  requireTestDatabaseUrl,
  closeDatabasePoolAfterTests,
  getAdminDb,
  seedTestUser,
} from "../helpers/testDatabase";

/**
 * ensureOwnerOrg (TEN-012 Task 5): lazy owner-org provisioning called at the
 * first authed wizard bootstrap, before W2's POST /facilities (which no longer
 * creates the org).
 *
 * Seeds directly through the admin connection (getAdminDb): ensureOwnerOrg
 * itself writes organizations/organization_members via the app `db`, and these
 * tests seed the prerequisite auth.users/public.users rows (+ an inviter org
 * and a pending invitation for case (c)), all of which need the elevated
 * access getAdminDb provides — matching the seedTestUser/seedTenantContext
 * pattern in the route suites. Skip-gated when no admin connection is
 * configured (`{ skip: !admin }`), same as every other DB-backed suite here.
 */
const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();
const hasAdmin = Boolean(process.env.TEST_ADMIN_DATABASE_URL);

describe("ensureOwnerOrg (TEN-012)", { skip: !dbUrl || !hasAdmin }, () => {
  async function load() {
    const { ensureOwnerOrg } = await import("../../lib/ensureOwnerOrg");
    const { usersTable, organizationsTable, organizationMembersTable, invitationsTable } = await import("@workspace/db");
    const admin = getAdminDb();
    return { ensureOwnerOrg, usersTable, organizationsTable, organizationMembersTable, invitationsTable, admin };
  }

  test("(a) fresh user, no membership, no invite -> creates \"<local>'s Farm\" + owner membership, created:true", async () => {
    const { ensureOwnerOrg, usersTable, organizationsTable, organizationMembersTable, admin } = await load();
    const userId = randomUUID();
    const local = `farmowner-${randomUUID().slice(0, 8)}`;
    const email = `${local}@ensureorg-test.example.com`;
    await seedTestUser(admin, usersTable, { id: userId, email });

    const result = await ensureOwnerOrg(userId, email);
    strictEqual(result.created, true);
    ok(result.organizationId, "an org id must be returned");

    const [org] = await admin.select().from(organizationsTable).where(eq(organizationsTable.id, result.organizationId!));
    strictEqual(org.name, `${local}'s Farm`);

    const [member] = await admin
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.userId, userId),
          eq(organizationMembersTable.organizationId, result.organizationId!),
        ),
      );
    ok(member, "an owner membership row must exist");
    strictEqual(member.role, "owner");
    strictEqual(member.status, "active");
  });

  test("(b) second call is idempotent -> same org, created:false", async () => {
    const { ensureOwnerOrg, usersTable, admin } = await load();
    const userId = randomUUID();
    const email = `idem-${randomUUID().slice(0, 8)}@ensureorg-test.example.com`;
    await seedTestUser(admin, usersTable, { id: userId, email });

    const first = await ensureOwnerOrg(userId, email);
    strictEqual(first.created, true);
    ok(first.organizationId);

    const second = await ensureOwnerOrg(userId, email);
    strictEqual(second.created, false);
    strictEqual(second.organizationId, first.organizationId, "the second call must resolve the same org, not create a new one");
  });

  test("(c) user whose email has a PENDING invitation -> {organizationId:null, created:false}, creates NO org", async () => {
    const { ensureOwnerOrg, usersTable, organizationsTable, invitationsTable, admin } = await load();
    // An inviter org + inviter user so the pending invitation's FKs resolve.
    const inviterId = randomUUID();
    await seedTestUser(admin, usersTable, {
      id: inviterId,
      email: `inviter-${randomUUID().slice(0, 8)}@ensureorg-test.example.com`,
    });
    const [inviterOrg] = await admin.insert(organizationsTable).values({ name: "Inviter Org" }).returning();
    const inviteeEmail = `invitee-${randomUUID().slice(0, 8)}@ensureorg-test.example.com`;
    await admin.insert(invitationsTable).values({
      organizationId: inviterOrg.id,
      email: inviteeEmail.toLowerCase(),
      role: "technician",
      tokenHash: `hash-${randomUUID()}`,
      status: "pending",
      invitedBy: inviterId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const orgsBefore = (await admin.select().from(organizationsTable)).length;
    const result = await ensureOwnerOrg(randomUUID(), inviteeEmail);
    strictEqual(result.organizationId, null);
    strictEqual(result.created, false);
    const orgsAfter = (await admin.select().from(organizationsTable)).length;
    strictEqual(orgsAfter, orgsBefore, "no org may be provisioned for an invite-pending user");
  });

  test("(d) email with an empty/whitespace local-part falls back to \"My Farm\"", async () => {
    const { ensureOwnerOrg, usersTable, organizationsTable, admin } = await load();
    const userId = randomUUID();
    // Local-part is whitespace-only; domain is randomized so auth.users' email
    // uniqueness holds across re-runs against the same database.
    const email = `   @ensureorg-${randomUUID().slice(0, 8)}.example.com`;
    await seedTestUser(admin, usersTable, { id: userId, email });

    const result = await ensureOwnerOrg(userId, email);
    strictEqual(result.created, true);
    const [org] = await admin.select().from(organizationsTable).where(eq(organizationsTable.id, result.organizationId!));
    strictEqual(org.name, "My Farm");
  });
});
