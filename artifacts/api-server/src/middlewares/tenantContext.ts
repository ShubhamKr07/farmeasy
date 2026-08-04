// artifacts/api-server/src/middlewares/tenantContext.ts
import type { Request, Response, NextFunction } from "express";
// NOTE: deliberately do NOT `import { getAuth } from "./supabaseAuth"` here.
// supabaseAuth.ts eagerly initializes the Supabase client at module-load
// time (process.env.SUPABASE_URL!.replace(...) at the top level), which
// crashes every test that loads this module without SUPABASE_URL set —
// exactly the deferral problem the db imports below already avoid. getAuth
// only reads req.supabaseUser (typed via the global Express augmentation
// declared in supabaseAuth.ts), so we read it inline here instead.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: {
        organizationId: number;
        facilityId: number;
        role: "owner" | "admin" | "technician";
      };
    }
  }
}

/**
 * Resolves { organizationId, facilityId, role } from organization_members
 * and attaches it to req.tenant. Never rejects — mirrors
 * supabaseAuthMiddleware's own "attach if present, let the route decide"
 * pattern (see that file's doc comment). Routes that are part of onboarding
 * itself (POST /facilities, GET /facilities/me, wizard progress,
 * facility-readiness) run for users who by definition have no membership
 * yet; a rejecting middleware here would break exactly those flows. Routes
 * that DO require tenant context use requireTenantContext (below),
 * mounted per-router, the same way app.ts already mounts requireSignedIn
 * selectively.
 *
 * Facility resolution is "the org's one facility" (facilities.organizationId
 * = the resolved org, take the only row) — MT-M2's TEN-008 changes this
 * lookup when multi-facility ships; it does not change this middleware's
 * shape or req.tenant's type.
 *
 * db/drizzle imports are deferred to dynamic imports inside this function so
 * that merely importing the module (e.g. in unit tests for
 * requireTenantContext) does not trigger @workspace/db initialization,
 * which requires DATABASE_URL to be set.
 */
export async function resolveTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const userId = req.supabaseUser?.sub ?? null;
  if (!userId) return next();

  // Defer db import to avoid initialization errors when DATABASE_URL is unset
  const { eq, and } = await import("drizzle-orm");
  const { db, organizationMembersTable, facilitiesTable } = await import("@workspace/db");

  // Never reject: a DB error (unreachable, wrong DB, transient) must not
  // break the request — this mirrors supabaseAuthMiddleware's own
  // attach-if-present-then-let-the-route-decide contract (see the doc comment
  // above). Public, DB-free routes like GET /healthz run through this
  // middleware in production (mounted globally in app.ts before the public
  // router) and must stay answering 200 even when the DB is down. Routes that
  // genuinely need tenant context mount requireTenantContext, which 403s on a
  // missing req.tenant — the route, not the resolver, decides.
  try {
    const [membership] = await db
      .select({
        organizationId: organizationMembersTable.organizationId,
        role: organizationMembersTable.role,
        facilityId: facilitiesTable.id,
      })
      .from(organizationMembersTable)
      .innerJoin(
        facilitiesTable,
        eq(facilitiesTable.organizationId, organizationMembersTable.organizationId),
      )
      .where(
        and(
          eq(organizationMembersTable.userId, userId),
          eq(organizationMembersTable.status, "active"),
        ),
      )
      .limit(1);

    if (membership) {
      req.tenant = {
        organizationId: membership.organizationId,
        facilityId: membership.facilityId,
        role: membership.role,
      };
    }
  } catch {
    // DB unavailable or query failed: leave req.tenant unset and proceed.
    // requireTenantContext (where mounted) is what surfaces a missing
    // membership to the client; this resolver never turns a DB blip into a
    // request failure.
  }
  return next();
}

/**
 * Assertion middleware for routes that require resolved tenant context —
 * mount per-router, same pattern as app.ts's requireSignedIn. 403, not 404:
 * the identity resolved (requireSignedIn already passed), there is simply no
 * membership — distinct from a resource-ownership 404 (Task 5+).
 */
export function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) {
    return res.status(403).json({ error: "No facility membership found" });
  }
  return next();
}
