import { db } from "@workspace/db";
import { organizationsTable, organizationMembersTable, invitationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * Lazily provisions the signed-in user's OWNER organization (TEN-012).
 *
 * Called at the first authed wizard bootstrap (GET /wizard/progress, first-run
 * case) so that by the time W2's POST /facilities runs, the org already
 * exists — POST /facilities no longer creates it. This moves org creation to a
 * new, earlier boundary; the runtime invariant is that the wizard bootstrap is
 * always hit before POST /facilities.
 *
 * Idempotent under concurrency via `SELECT ... FOR UPDATE` on the user's
 * membership row inside a single transaction, plus the one-org-per-user unique
 * index on organization_members.user_id as the ultimate backstop.
 *
 * Three outcomes:
 *  - existing active membership   → { organizationId, created: false }
 *  - a PENDING invitation for this email → { organizationId: null, created:
 *    false }: the invite path owns this user's eventual org membership, so we
 *    must NOT self-provision one (that would collide with accept and leave an
 *    orphan owner org).
 *  - otherwise                    → INSERT a fresh org + owner membership,
 *    { organizationId, created: true }.
 *
 * Deliberately does NOT touch the deprecated users.organization_id column (it
 * is being retired; POST /facilities' matching write is stripped too).
 *
 * Reads organization_members + invitations directly via `db` (bootstrap
 * pattern, same as facilities.ts / wizard.ts): there is no resolved tenant
 * context yet at this point in the request lifecycle — provisioning it is the
 * whole point — so withTenantScope is not applicable.
 */
export async function ensureOwnerOrg(
  userId: string,
  email: string,
): Promise<{ organizationId: number | null; created: boolean }> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ organizationId: organizationMembersTable.organizationId })
      .from(organizationMembersTable)
      .where(
        and(eq(organizationMembersTable.userId, userId), eq(organizationMembersTable.status, "active")),
      )
      .limit(1)
      .for("update");
    if (membership) return { organizationId: membership.organizationId, created: false };

    // Invitations store the email trimmed + lowercased (invitations.ts); match
    // that exactly so an invited user is never given a spurious auto-org.
    const [invite] = await tx
      .select({ id: invitationsTable.id })
      .from(invitationsTable)
      .where(
        and(eq(invitationsTable.email, email.trim().toLowerCase()), eq(invitationsTable.status, "pending")),
      )
      .limit(1);
    if (invite) return { organizationId: null, created: false }; // invite path owns this user

    const local = email.split("@")[0]?.trim();
    const name = local ? `${local}'s Farm` : "My Farm";
    const [org] = await tx.insert(organizationsTable).values({ name }).returning();
    await tx.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId,
      role: "owner",
      status: "active",
    });
    return { organizationId: org.id, created: true };
  });
}
