import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db, organizationMembersTable, usersTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";

// TEN-010 Task 7: member management (change role / remove), owner/admin
// gated. Same self-mounting pattern as invitations.ts — this router carries
// its own requireTenantContext + requireRole("owner", "admin"), so it must be
// mounted respecting app.ts's tier-2 ordering rule if/when wired into app.ts
// (see tenantContext.ts's doc comment on that file).
const router = Router();
router.use(requireTenantContext, requireRole("owner", "admin"));

// req.params values are typed `string | string[]` in this Express version
// (see cycles.ts's parseParamId for the same pattern) -- normalize to a
// single string before handing it to drizzle's `eq()`, which only accepts a
// scalar.
function paramUserId(req: Request): string {
  const v = req.params["userId"];
  return Array.isArray(v) ? v[0] : v;
}

// GET /members — active members of the caller's org.
router.get("/members", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const rows = await db
      .select({
        userId: organizationMembersTable.userId,
        email: usersTable.email,
        role: organizationMembersTable.role,
        status: organizationMembersTable.status,
      })
      .from(organizationMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
      .where(
        and(
          eq(organizationMembersTable.organizationId, organizationId),
          eq(organizationMembersTable.status, "active"),
        ),
      );
    return res.status(200).json(rows);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to list members" });
  }
});

const RoleSchema = z.object({ role: z.enum(["admin", "technician"]) }); // never owner

// PATCH /members/:userId/role — admin<->technician only; never touch owner.
router.patch("/members/:userId/role", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const parsed = RoleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "role must be admin or technician" });
    const [updated] = await db
      .update(organizationMembersTable)
      .set({ role: parsed.data.role })
      .where(
        and(
          eq(organizationMembersTable.userId, paramUserId(req)),
          eq(organizationMembersTable.organizationId, organizationId),
          eq(organizationMembersTable.status, "active"),
          ne(organizationMembersTable.role, "owner"), // owner is immutable
        ),
      )
      .returning({ userId: organizationMembersTable.userId });
    if (!updated) return res.status(404).json({ error: "Member not found or not modifiable" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update member role" });
  }
});

// DELETE /members/:userId — soft-remove (status='removed'); never the owner.
router.delete("/members/:userId", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const [updated] = await db
      .update(organizationMembersTable)
      .set({ status: "removed" })
      .where(
        and(
          eq(organizationMembersTable.userId, paramUserId(req)),
          eq(organizationMembersTable.organizationId, organizationId),
          eq(organizationMembersTable.status, "active"),
          ne(organizationMembersTable.role, "owner"),
        ),
      )
      .returning({ userId: organizationMembersTable.userId });
    if (!updated) return res.status(404).json({ error: "Member not found or not removable" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
