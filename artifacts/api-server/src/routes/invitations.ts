import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  invitationsTable,
  organizationMembersTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";
import { generateInviteToken } from "../lib/inviteToken";
import { sendInvite } from "../lib/email";

const router = Router();

// All routes in THIS router require a resolved tenant AND owner/admin. The
// accept endpoint (Task 6) is deliberately mounted on a SEPARATE, ungated
// router (accept has no session/tenant/role — the invitee may not be a member
// yet). Keep these split.
router.use(requireTenantContext, requireRole("owner", "admin"));

const CreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "technician"]), // never owner
});

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// POST /invitations — owner/admin invites by email + role.
router.post("/invitations", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { email, role } = parsed.data;
    const { organizationId } = req.tenant!;

    // One-org-per-user: reject if this email is already an active member of any org.
    const existing = await db
      .select({ id: organizationMembersTable.id })
      .from(organizationMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
      .where(
        and(
          eq(usersTable.email, email),
          eq(organizationMembersTable.status, "active"),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ error: "That email already belongs to an organization" });
    }

    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    // Re-invite refreshes the existing pending row (partial unique index on
    // (org,email) where status='pending') rather than duplicating.
    const [row] = await db
      .insert(invitationsTable)
      .values({ organizationId, email, role, tokenHash: hash, invitedBy: userId!, expiresAt })
      .onConflictDoUpdate({
        target: [invitationsTable.organizationId, invitationsTable.email],
        targetWhere: eq(invitationsTable.status, "pending"),
        set: { role, tokenHash: hash, expiresAt, invitedBy: userId!, createdAt: new Date() },
      })
      .returning();

    const [org] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));

    const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:5173";
    await sendInvite({
      to: email,
      inviteUrl: `${dashboardUrl}/accept-invite#token=${raw}`,
      orgName: org?.name ?? "your organization",
      role,
    });

    return res.status(201).json({ id: row.id, email: row.email, role: row.role, status: row.status });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create invitation" });
  }
});

// GET /invitations — pending invites for the caller's org.
router.get("/invitations", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const rows = await db
      .select({
        id: invitationsTable.id,
        email: invitationsTable.email,
        role: invitationsTable.role,
        status: invitationsTable.status,
        expiresAt: invitationsTable.expiresAt,
        createdAt: invitationsTable.createdAt,
      })
      .from(invitationsTable)
      .where(and(eq(invitationsTable.organizationId, organizationId), eq(invitationsTable.status, "pending")));
    return res.status(200).json(rows);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to list invitations" });
  }
});

// DELETE /invitations/:id — revoke a pending invite (own org only).
router.delete("/invitations/:id", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const [updated] = await db
      .update(invitationsTable)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitationsTable.id, id),
          eq(invitationsTable.organizationId, organizationId),
          eq(invitationsTable.status, "pending"),
        ),
      )
      .returning({ id: invitationsTable.id });
    if (!updated) return res.status(404).json({ error: "Invitation not found" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

export default router;
