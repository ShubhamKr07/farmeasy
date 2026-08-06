import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * POST/GET/DELETE /invitations — owner/admin-only invite management
 * (TEN-010 Task 5). The router self-mounts requireTenantContext +
 * requireRole("owner", "admin") internally, so a technician-role caller must
 * be rejected before any handler runs.
 *
 * Gated on TEST_DATABASE_URL, same convention as tasks.test.ts. EMAIL_TRANSPORT
 * is forced to "record" in `before` so sendInvite's Resend-bound call records
 * in-memory instead of hitting the network.
 */
describe(
  "POST/GET/DELETE /invitations",
  { skip: !requireTestDatabaseUrl() },
  () => {
    before(() => {
      process.env.EMAIL_TRANSPORT = "record";
    });

    // Truncated before each test — invitations rows must not leak across
    // tests within this file (node:test's `before` runs once per describe,
    // not per test; see useDatabaseFixture's own doc comment for the
    // count-based-assertion bug this avoids).
    const fixture = useDatabaseFixture(["invitations"]);

    async function setup() {
      const invitations = await import("../../routes/invitations");
      const {
        db,
        invitationsTable,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "owner@example.com" },
        { memberRole: "owner" },
      );
      return {
        app: createAuthenticatedTestApp(invitations.default, DEFAULT_TEST_USER, facilityId),
        db,
        invitationsTable,
        facilityId,
      };
    }

    async function setupTechnician() {
      const invitations = await import("../../routes/invitations");
      const {
        db,
        invitationsTable,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "tech@example.com" },
        { memberRole: "technician" },
      );
      return {
        app: createAuthenticatedTestApp(invitations.default, DEFAULT_TEST_USER, facilityId),
        db,
        invitationsTable,
        facilityId,
      };
    }

    // A second, independent owner in a SEPARATE org — used by the cross-org
    // isolation test. Distinct synthetic user id from DEFAULT_TEST_USER.sub
    // so seedTenantContext's onConflictDoUpdate(target: userId) creates a
    // fresh organization_members row rather than moving DEFAULT_TEST_USER's
    // own membership onto a new org.
    const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000003";

    async function setupOtherOrgOwner() {
      const invitations = await import("../../routes/invitations");
      const {
        db,
        invitationsTable,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: OTHER_OWNER_ID, email: "other-owner@example.com" },
        { memberRole: "owner", farmName: "Other Farm" },
      );
      return {
        app: createAuthenticatedTestApp(invitations.default, { sub: OTHER_OWNER_ID }, facilityId),
        db,
        invitationsTable,
        facilityId,
      };
    }

    test("owner can create an invite; a Resend-bound email is queued and pending row exists", async () => {
      const { app, db, invitationsTable } = await setup();
      const { resetRecordedEmails, getRecordedEmails } = await import("../../lib/email");
      resetRecordedEmails();
      const res = await request(app)
        .post("/api/invitations")
        .send({ email: "new@ex.com", role: "technician" });
      strictEqual(res.status, 201);
      strictEqual(getRecordedEmails().length, 1);
      const rows = await db.select().from(invitationsTable);
      strictEqual(rows.length, 1);
      strictEqual(rows[0].status, "pending");
      strictEqual(rows[0].email, "new@ex.com");
    });

    test("invite rejects role=owner", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/invitations")
        .send({ email: "x@ex.com", role: "owner" });
      strictEqual(res.status, 400);
    });

    test("GET /invitations lists pending invites", async () => {
      const { app } = await setup();
      await request(app).post("/api/invitations").send({ email: "a@ex.com", role: "admin" });
      const res = await request(app).get("/api/invitations");
      strictEqual(res.status, 200);
      strictEqual(res.body.length, 1);
    });

    test("DELETE /invitations/:id revokes it", async () => {
      const { app, db, invitationsTable } = await setup();
      const created = await request(app)
        .post("/api/invitations")
        .send({ email: "r@ex.com", role: "technician" });
      const id = created.body.id;
      const res = await request(app).delete(`/api/invitations/${id}`);
      strictEqual(res.status, 200);
      const rows = await db.select().from(invitationsTable);
      strictEqual(rows[0].status, "revoked");
    });

    test("a technician cannot create invites (403 ROLE_FORBIDDEN)", async () => {
      const { app } = await setupTechnician();
      const res = await request(app)
        .post("/api/invitations")
        .send({ email: "n@ex.com", role: "admin" });
      strictEqual(res.status, 403);
      strictEqual(res.body.code, "ROLE_FORBIDDEN");
    });

    test("invite is rejected when the email already belongs to an active org member (one-org-per-user)", async () => {
      const { app, db, invitationsTable } = await setup();
      const {
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      // A SECOND user, already an active member of a DIFFERENT org than the
      // caller's. The caller (org A's owner) tries to invite that email.
      await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: "00000000-0000-4000-8000-000000000002", email: "already-member@example.com" },
        { memberRole: "technician", farmName: "Someone Else's Farm" },
      );

      const res = await request(app)
        .post("/api/invitations")
        .send({ email: "already-member@example.com", role: "technician" });
      strictEqual(res.status, 400);

      const rows = await db
        .select()
        .from(invitationsTable)
        .where(eq(invitationsTable.email, "already-member@example.com"));
      strictEqual(rows.length, 0, "no pending invitation should be created for an already-member email");
    });

    test("re-inviting the same email refreshes the pending row instead of duplicating it", async () => {
      const { app, db, invitationsTable } = await setup();

      const first = await request(app)
        .post("/api/invitations")
        .send({ email: "dup@ex.com", role: "technician" });
      strictEqual(first.status, 201);

      const second = await request(app)
        .post("/api/invitations")
        .send({ email: "dup@ex.com", role: "admin" });
      strictEqual(second.status, 201);

      const rows = await db.select().from(invitationsTable).where(eq(invitationsTable.email, "dup@ex.com"));
      strictEqual(rows.length, 1, "re-inviting must refresh the existing row, not duplicate it");
      strictEqual(rows[0].status, "pending");
      strictEqual(rows[0].role, "admin", "the refreshed row should carry the latest invite's role");
    });

    test("cross-org isolation: another org's owner cannot see or revoke this org's invite", async () => {
      const { app: appA, db, invitationsTable } = await setup();
      const created = await request(appA)
        .post("/api/invitations")
        .send({ email: "isolated@ex.com", role: "technician" });
      strictEqual(created.status, 201);
      const inviteId = created.body.id;

      const { app: appB } = await setupOtherOrgOwner();

      const listRes = await request(appB).get("/api/invitations");
      strictEqual(listRes.status, 200);
      ok(
        !listRes.body.some((inv: { id: number }) => inv.id === inviteId),
        "org B's invitation list must not include org A's invite",
      );

      const deleteRes = await request(appB).delete(`/api/invitations/${inviteId}`);
      strictEqual(deleteRes.status, 404);

      const rows = await db.select().from(invitationsTable).where(eq(invitationsTable.id, inviteId));
      strictEqual(rows[0].status, "pending", "org A's invite must remain pending after org B's failed delete");
    });
  },
);
