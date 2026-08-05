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
 * Public probe paths that must never trigger tenant resolution. /healthz is
 * process-liveness only (zero I/O by design — see routes/health.ts) and
 * /readyz runs its own bounded SELECT 1; running a membership lookup here
 * would both add latency to the probe and, when the DB is slow/down, make a
 * DB blip look like a process problem — exactly what the liveness/readiness
 * split exists to avoid. These routes carry no authenticated identity in
 * production anyway (no bearer token), so req.supabaseUser is absent and the
 * userId guard below would short-circuit regardless — but skipping by path
 * keeps the probe DB-free even when a caller (or a test double) attaches an
 * identity, and it stops the resolver's timeout from stacking on top of
 * /readyz's own 2s budget.
 */
const PUBLIC_PROBE_PATHS = new Set(["/api/healthz", "/api/readyz"]);

/**
 * Hard ceiling on a single membership lookup, in milliseconds. Bounds a
 * hung/slow query or a pool-connect stall so a DB blip can never pin a
 * request longer than this — the resolver then leaves req.tenant unset and
 * lets requireTenantContext (where mounted) surface the missing membership.
 * Matches the /readyz readiness budget so a tenant lookup can never outlast
 * the platform's own probe window.
 */
const TENANT_LOOKUP_TIMEOUT_MS = 2000;

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
  // Public liveness/readiness probes must stay DB-free (see health.ts) —
  // never resolve tenant context for them, even if an identity is attached.
  if (PUBLIC_PROBE_PATHS.has(req.path)) return next();

  const userId = req.supabaseUser?.sub ?? null;
  if (!userId) return next();

  // Never reject: a DB error (unreachable, wrong DB, transient, or timeout)
  // must not break the request — this mirrors supabaseAuthMiddleware's own
  // attach-if-present-then-let-the-route-decide contract (see the doc comment
  // above). Routes that genuinely need tenant context mount
  // requireTenantContext, which 403s on a missing req.tenant — the route,
  // not the resolver, decides.
  try {
    // Defer db import to avoid initialization errors when DATABASE_URL is
    // unset (e.g. unit tests that only exercise requireTenantContext).
    const dbOperation = async () => {
      const { eq, and } = await import("drizzle-orm");
      const { db, organizationMembersTable, facilitiesTable } = await import("@workspace/db");

      // organization_members' backend-role SELECT policy (00012) is
      // unqualified (current_user = 'farmsmart_app', not scoped by userId) --
      // safe here only because this WHERE clause itself filters by userId
      // before any RLS-admitted row reaches the app. If a future endpoint
      // ever lists OTHER users' memberships, it must carry its own explicit
      // org/facility filter -- RLS will not scope that query for you.
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

      return membership ?? null;
    };

    // Race the lookup against a hard timeout so a hung query or a
    // pool-connect stall can never pin the request (or hang the process, as
    // it did before this bound existed). On timeout the resolver resolves
    // null → req.tenant stays unset → requireTenantContext (where mounted)
    // surfaces the missing membership.
    const membership = await withTimeout(dbOperation(), TENANT_LOOKUP_TIMEOUT_MS);

    if (membership) {
      req.tenant = {
        organizationId: membership.organizationId,
        facilityId: membership.facilityId,
        role: membership.role,
      };
    }
  } catch (error) {
    // DB unavailable or query failed (import error, connection refused, auth
    // failure, etc.): leave req.tenant unset and proceed. requireTenantContext
    // (where mounted) is what surfaces a missing membership to the client;
    // this resolver never turns a DB blip into a request failure. Logged at
    // warn (not error) because an unreachable DB in dev/test is expected, and
    // the message is reduced to the error message (no stack) so it can't spam
    // stderr on every request when the DB is down.
    console.warn(
      "[tenantContext] membership lookup failed; req.tenant unset:",
      error instanceof Error ? error.message : error,
    );
  }
  return next();
}

/**
 * Race a promise against a timeout. Resolves to the promise's value if it
 * settles first; resolves to `null` if the timeout fires first. Rejections
 * from the promise propagate (so the caller's try/catch still handles hard
 * failures like an unreachable DB). The timer is unref'd so it can never
 * keep the event loop alive on its own.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
