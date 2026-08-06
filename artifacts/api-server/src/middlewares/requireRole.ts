import type { Request, Response, NextFunction } from "express";

type OrgRole = "owner" | "admin" | "technician";

/**
 * Role gate for web-only API surfaces (TEN-010). Reads req.tenant.role
 * (resolved server-side by resolveTenantContext) and 403s with the stable
 * code ROLE_FORBIDDEN when the caller's role is not in `allowed` (or when no
 * tenant resolved at all). This is THE control — UI hiding is not. Mount per
 * router, after requireTenantContext, respecting app.ts's mount-order tiers
 * (a short-circuiting gate mounted ahead of an unrelated router would
 * intercept it — see app.ts's tier comment).
 */
export function requireRole(...allowed: OrgRole[]) {
  return function (req: Request, res: Response, next: NextFunction) {
    const role = req.tenant?.role;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: "Forbidden for this role", code: "ROLE_FORBIDDEN" });
    }
    return next();
  };
}
