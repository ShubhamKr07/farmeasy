import { describe, test, before } from "node:test";
import { strictEqual } from "node:assert";
import request from "supertest";
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
  },
);
