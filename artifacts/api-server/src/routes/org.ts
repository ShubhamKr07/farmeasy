// artifacts/api-server/src/routes/org.ts
import { Router, type Request, type Response } from "express";
import { and, eq, ne, inArray, count } from "drizzle-orm";
import { db, withTenantScope, organizationMembersTable, facilitiesTable, cyclesTable, alertsTable } from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

/**
 * Resolves the caller's active org, gated to owner/admin roles ONLY, entirely
 * server-side from organization_members (never client input). Folds "resolve
 * the org" and "gate the role" into a single WHERE clause rather than two
 * separate steps.
 *
 * IMPORTANT DEVIATION FROM THE TEN-009 PLAN'S DRAFT CODE: the plan's Task 1
 * sketch imports `requireRole` from `../middlewares/requireRole` as a
 * per-route arg. That middleware reads `req.tenant?.role`
 * (middlewares/requireRole.ts) -- and `req.tenant` is populated by
 * `resolveTenantContext` (middlewares/tenantContext.ts) ONLY when the request
 * carries an `X-Facility-Id` header (see tenantContext.ts's early `if
 * (!facilityIdHeader) return next();`). This route is deliberately org-scoped
 * with NO `X-Facility-Id` (an org-wide rollup has no single "active
 * facility" -- see the TEN-009 design doc's Product Decision #3), so
 * `req.tenant` is *always* undefined here and `requireRole("owner","admin")`
 * would 403 every caller unconditionally, including legitimate owners/admins
 * -- verified by reading tenantContext.ts before trusting the plan's literal
 * import (fail-closed, but not the intended behavior, and it would fail the
 * "owner of A -> 200" test outright). This helper is the fix: it resolves the
 * org AND enforces the owner/admin gate in one query, independent of
 * X-Facility-Id / req.tenant, mirroring demo.ts's getOwnerOrg (extended here
 * to admit "admin" as well as "owner", per the design doc's own suggestion).
 */
async function getManagementOrg(userId: string): Promise<number | null> {
  const [membership] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.userId, userId),
        eq(organizationMembersTable.status, "active"),
        inArray(organizationMembersTable.role, ["owner", "admin"]),
      ),
    )
    .limit(1);
  return membership?.organizationId ?? null;
}

// GET /org/summary — owner/admin org rollup stub (TEN-009). Org-scoped, no
// X-Facility-Id: org resolved server-side via getManagementOrg above, which
// also enforces the owner/admin gate (see its doc comment for why this
// route can't use middlewares/requireRole.ts as a per-route arg). Self-
// contained (no router.use()), so it's tier-1-safe regardless -- it can
// never intercept a different, later-mounted router the way an unconditional
// router-level gate could (see app.ts's own mount-order tier comment).
// Aggregates across the org's facilities via a per-facility withTenantScope
// loop, so each count runs under the facility-GUC RLS (00007). No new
// migration/schema/RLS.
router.get("/org/summary", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const organizationId = await getManagementOrg(userId);
    if (!organizationId) {
      // Covers both "no active membership at all" and "an active membership
      // that isn't owner/admin" (e.g. a technician) -- both collapse to the
      // same ROLE_FORBIDDEN response, matching requireRole.ts's own shape/code
      // so this route's error surface is indistinguishable from a real
      // requireRole 403 to any caller.
      return res.status(403).json({ error: "Forbidden for this role", code: "ROLE_FORBIDDEN" });
    }

    // facilities' RLS is the farmsmart_app current_user backstop (Batch 1);
    // the org filter is the scope. Never client input.
    const facilities = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.organizationId, organizationId));

    let activeCycles = 0;
    let openAlerts = 0;
    for (const f of facilities) {
      const [c, a] = await withTenantScope({ organizationId, facilityId: f.id }, async (tx) => {
        // Explicit facilityId filter alongside the RLS scope set by
        // withTenantScope -- NEVER rely on RLS alone, matching every other
        // withTenantScope call site in this codebase (e.g. alerts.ts's own
        // GET /alerts: `eq(alertsTable.facilityId, req.tenant!.facilityId)`
        // sits ALONGSIDE the RLS-scoping transaction, not instead of it).
        // Caught empirically: the plan's own Step 3 draft omitted this filter
        // (RLS-only), and under the disposable test stack's `db` connection
        // (the `postgres` superuser -- BYPASSRLS, see
        // scripts/ci/test-disposable-supabase.sh's TEST_DATABASE_URL and
        // demo.test.ts's own RLS-regression-test comment) that produced a
        // real leak: this loop's per-facility count silently became a
        // whole-database count across every org/facility, not just this one.
        const [{ n: cyc }] = await tx
          .select({ n: count() })
          .from(cyclesTable)
          .where(and(eq(cyclesTable.facilityId, f.id), ne(cyclesTable.status, "completed")));
        const [{ n: alr }] = await tx
          .select({ n: count() })
          .from(alertsTable)
          .where(and(eq(alertsTable.facilityId, f.id), eq(alertsTable.status, "current")));
        return [Number(cyc), Number(alr)] as const;
      });
      activeCycles += c;
      openAlerts += a;
    }

    return res.status(200).json({ facilityCount: facilities.length, activeCycles, openAlerts });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to compute org summary" });
  }
});

export default router;
