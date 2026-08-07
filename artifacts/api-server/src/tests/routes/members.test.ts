import { describe, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTenantContext,
  seedTestUser,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";

closeDatabasePoolAfterTests();

/**
 * GET/PATCH/DELETE /members — owner/admin-only member management (TEN-010
 * Task 7). The router self-mounts requireTenantContext +
 * requireRole("owner", "admin") internally, same convention as
 * invitations.ts. Owner rows are immutable: the `ne(role, "owner")` guard in
 * both PATCH and DELETE makes any attempt to change/remove the owner miss
 * (0 rows updated) and surface as a 404, the same "not found or not
 * modifiable" shape a cross-org target userId produces.
 *
 * Unlike invitations.test.ts (which never truncates the shared
 * organization_members table), THIS suite truncates it before every test —
 * organization_members is exactly what these routes read/write, so each test
 * needs a clean slate rather than accreting rows across the file.
 */
describe(
  "GET/PATCH/DELETE /members",
  { skip: !requireTestDatabaseUrl() },
  () => {
    const fixture = useDatabaseFixture(["organization_members"]);

    // Fixed synthetic ids for the extra (non-owner) members seeded alongside
    // the owner in setupOwnerWithMembers(). Distinct from DEFAULT_TEST_USER.sub
    // and from each other so organization_members' unique user_id index never
    // collides within a single test.
    const ADMIN_ID = "00000000-0000-4000-8000-000000000030";
    const TECH_ID = "00000000-0000-4000-8000-000000000031";
    const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000032";

    async function insertMember(
      db: unknown,
      organizationMembersTable: unknown,
      organizationId: number,
      userId: string,
      role: "owner" | "admin" | "technician",
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = (getAdminDb() ?? db) as any;
      await target
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(organizationMembersTable as any)
        .values({ organizationId, userId, role, status: "active" })
        .onConflictDoUpdate({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          target: (organizationMembersTable as any).userId,
          set: { organizationId, role, status: "active" },
        });
    }

    async function setupOwnerWithMembers() {
      const members = await import("../../routes/members");
      const {
        db,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { organizationId, facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "owner@example.com" },
        { memberRole: "owner" },
      );
      await seedTestUser(db, usersTable, { id: ADMIN_ID, email: "admin@example.com" });
      await insertMember(db, organizationMembersTable, organizationId, ADMIN_ID, "admin");
      await seedTestUser(db, usersTable, { id: TECH_ID, email: "tech@example.com" });
      await insertMember(db, organizationMembersTable, organizationId, TECH_ID, "technician");

      return {
        app: createAuthenticatedTestApp(members.default, DEFAULT_TEST_USER, facilityId),
        db,
        organizationMembersTable,
        organizationId,
        facilityId,
      };
    }

    async function setupTechnicianCaller() {
      const members = await import("../../routes/members");
      const {
        db,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      const { facilityId } = await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: DEFAULT_TEST_USER.sub, email: "tech-caller@example.com" },
        { memberRole: "technician" },
      );
      return {
        app: createAuthenticatedTestApp(members.default, DEFAULT_TEST_USER, facilityId),
      };
    }

    test("owner lists active members of their org", async () => {
      const { app } = await setupOwnerWithMembers();
      const res = await request(app).get("/api/members");
      strictEqual(res.status, 200);
      strictEqual(res.body.length, 3, "owner + admin + technician");
      const roles = res.body.map((m: { role: string }) => m.role).sort();
      ok(roles.includes("owner"));
      ok(roles.includes("admin"));
      ok(roles.includes("technician"));
    });

    test("owner changes an admin's role to technician", async () => {
      const { app, db, organizationMembersTable } = await setupOwnerWithMembers();
      const res = await request(app)
        .patch(`/api/members/${ADMIN_ID}/role`)
        .send({ role: "technician" });
      strictEqual(res.status, 200);
      const [row] = await db
        .select()
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, ADMIN_ID));
      strictEqual(row.role, "technician");
    });

    test("owner changes a technician's role to admin", async () => {
      const { app, db, organizationMembersTable } = await setupOwnerWithMembers();
      const res = await request(app)
        .patch(`/api/members/${TECH_ID}/role`)
        .send({ role: "admin" });
      strictEqual(res.status, 200);
      const [row] = await db
        .select()
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, TECH_ID));
      strictEqual(row.role, "admin");
    });

    test("removing a member sets status='removed' (soft-remove)", async () => {
      const { app, db, organizationMembersTable } = await setupOwnerWithMembers();
      const res = await request(app).delete(`/api/members/${TECH_ID}`);
      strictEqual(res.status, 200);
      const [row] = await db
        .select()
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, TECH_ID));
      strictEqual(row.status, "removed");
    });

    test("cannot change the owner's role (404, owner untouched)", async () => {
      const { app, db, organizationMembersTable } = await setupOwnerWithMembers();
      const res = await request(app)
        .patch(`/api/members/${DEFAULT_TEST_USER.sub}/role`)
        .send({ role: "admin" });
      strictEqual(res.status, 404);
      const [row] = await db
        .select()
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
      strictEqual(row.role, "owner");
    });

    test("cannot remove the owner (404, owner still active)", async () => {
      const { app, db, organizationMembersTable } = await setupOwnerWithMembers();
      const res = await request(app).delete(`/api/members/${DEFAULT_TEST_USER.sub}`);
      strictEqual(res.status, 404);
      const [row] = await db
        .select()
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, DEFAULT_TEST_USER.sub));
      strictEqual(row.status, "active");
    });

    test("a technician gets 403 ROLE_FORBIDDEN", async () => {
      const { app } = await setupTechnicianCaller();
      const res = await request(app).get("/api/members");
      strictEqual(res.status, 403);
      strictEqual(res.body.code, "ROLE_FORBIDDEN");
    });

    test("a cross-org target userId returns 404 (no cross-org role change/removal)", async () => {
      const { app } = await setupOwnerWithMembers();
      const {
        db,
        usersTable,
        organizationsTable,
        facilitiesTable,
        organizationMembersTable,
      } = await import("@workspace/db");
      // A second, independent owner in a SEPARATE org — same pattern as
      // invitations.test.ts's setupOtherOrgOwner. auth.users.email carries a
      // unique index and is never truncated across suites/runs, so the email
      // is folded around OTHER_OWNER_ID (not a bare literal) to avoid a
      // cross-run/cross-suite collision — the exact residue class documented
      // in task-7-report.md's wizard.test.ts fix.
      await seedTenantContext(
        db,
        { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
        { id: OTHER_OWNER_ID, email: `other-owner-${OTHER_OWNER_ID}@members-test.example.com` },
        { memberRole: "owner", farmName: "Other Farm" },
      );

      const patchRes = await request(app)
        .patch(`/api/members/${OTHER_OWNER_ID}/role`)
        .send({ role: "admin" });
      strictEqual(patchRes.status, 404);

      const deleteRes = await request(app).delete(`/api/members/${OTHER_OWNER_ID}`);
      strictEqual(deleteRes.status, 404);
    });
  },
);
