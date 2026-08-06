import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db, invitationsTable, organizationMembersTable, usersTable } from "@workspace/db";
import { hashInviteToken } from "../lib/inviteToken";

const router = Router();

const AcceptSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).optional(), // required only when the user is new
});

function admin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// POST /invitations/accept — token-authenticated; deliberately NOT behind
// requireTenantContext/requireSignedIn (the invitee may have no account yet).
router.post("/invitations/accept", async (req: Request, res: Response) => {
  try {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed" });
    const { token, password } = parsed.data;

    // Atomically claim the pending, unexpired, unrevoked invite (single-use):
    // flip to 'accepted' only if it is currently 'pending'; the WHERE guard is
    // the race-safe single-use control.
    const now = new Date();
    const hash = hashInviteToken(token);
    const [invite] = await db
      .update(invitationsTable)
      .set({ status: "accepted", acceptedAt: now })
      .where(and(eq(invitationsTable.tokenHash, hash), eq(invitationsTable.status, "pending")))
      .returning();
    if (!invite) return res.status(400).json({ error: "This invitation is invalid, expired, or already used" });
    if (invite.expiresAt.getTime() < now.getTime()) {
      // Was pending but expired: mark expired, fail safe. (Flip back so the row
      // reflects reality; the accept did not take effect.)
      await db.update(invitationsTable).set({ status: "expired", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
      return res.status(400).json({ error: "This invitation has expired" });
    }

    // One-org-per-user: if the email already maps to an active membership, bail
    // (and revert the claim so the invite can be re-issued cleanly).
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, invite.email)).limit(1);
    if (existingUser) {
      const [member] = await db
        .select({ id: organizationMembersTable.id })
        .from(organizationMembersTable)
        .where(and(eq(organizationMembersTable.userId, existingUser.id), eq(organizationMembersTable.status, "active")))
        .limit(1);
      if (member) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: "That email already belongs to an organization" });
      }
    }

    // Create the Supabase user if new (email pre-confirmed — no email sent).
    let userId = existingUser?.id ?? null;
    if (!userId) {
      if (!password) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: "A password is required to create your account" });
      }
      const { data, error } = await admin().auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: `Could not create account: ${error?.message ?? "unknown"}` });
      }
      userId = data.user.id;
      // handle_new_user() trigger creates the public.users row; nothing to do here.
    }

    // Insert the membership with the invited role (active).
    await db.insert(organizationMembersTable).values({
      organizationId: invite.organizationId,
      userId: userId!,
      role: invite.role,
      status: "active",
    });

    return res.status(201).json({ organizationId: invite.organizationId, role: invite.role, email: invite.email });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to accept invitation" });
  }
});

export default router;
