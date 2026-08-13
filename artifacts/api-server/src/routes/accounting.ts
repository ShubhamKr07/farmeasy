import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUri,
  saveConnectionFromCallback,
  getConnectionStatus,
  disconnect,
} from "../lib/accounting/quickbooks";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";

/**
 * QuickBooks OAuth connect/callback/status/disconnect.
 *
 * `callback` MUST stay public: Intuit redirects the user's browser directly
 * to it, and the SPA↔API pair here authenticates via a Bearer token in the
 * Authorization header (not cookies), which a top-level browser redirect
 * cannot carry. Instead, a short-lived CSRF `state` generated in `connect`
 * (in-memory — the OAuth round trip is seconds long, no persistence needed)
 * maps back to the Clerk user id, so the callback can attribute the
 * connection without itself being an authenticated request.
 */
const pendingStates = new Map<string, { userId: string; organizationId: number; expiresAt: number }>();

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

// ── Authenticated router (mount behind requireSignedIn) ────────────────────

export const accountingRouter = Router();

// All routes in THIS router require a resolved tenant AND owner/admin — QuickBooks
// connection management/financial status has no legitimate technician use case
// (Task 11 remediation, same self-gate pattern as invitations.ts/members.ts). Must
// be mounted in app.ts's tier 4 (after every router a technician is allowed to
// reach) — see app.ts's tiering comment. Does NOT apply to accountingPublicRouter
// below (the OAuth callback has no session at all — see its own doc comment).
accountingRouter.use(requireTenantContext, requireRole("owner", "admin"));

accountingRouter.get("/accounting/connect", (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  cleanupExpiredStates();
  const state = randomBytes(16).toString("hex");
  // Store organizationId alongside userId -- the unauthenticated callback
  // below has no req.tenant to read it from otherwise.
  pendingStates.set(state, { userId: userId, organizationId: req.tenant!.organizationId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const uri = getAuthorizeUri(state);
  return res.json({ authorizeUri: uri });
});

accountingRouter.get("/accounting/status", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const status = await getConnectionStatus(userId, req.tenant!.organizationId);
  return res.json(status);
});

accountingRouter.post("/accounting/disconnect", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const ok = await disconnect(userId, req.tenant!.organizationId);
  return res.json({ disconnected: ok });
});

// ── Public router (mount before requireSignedIn) ───────────────────────────

export const accountingPublicRouter = Router();

accountingPublicRouter.get("/accounting/callback", async (req: Request, res: Response) => {
  const state = req.query.state as string | undefined;
  const entry = state ? pendingStates.get(state) : undefined;

  // Dedicated dashboard redirect target (Release 1 Task 9 Step 3). This used
  // to reuse CORS_ORIGIN, which was always fragile (CORS_ORIGIN configured
  // allowed CORS origins, not a redirect destination) and would have silently
  // broken the redirect once CORS_ORIGIN became a comma-separated list
  // (CORS_ORIGINS). Falls back to "/" when unset so the route still functions
  // in local dev without configuration.
  const dashboardUrl = process.env.DASHBOARD_URL ?? "/";
  const redirectWithStatus = (status: "connected" | "error", message?: string) => {
    const url = new URL(`${dashboardUrl}/accounting`);
    url.searchParams.set("qbo", status);
    if (message) url.searchParams.set("message", message);
    return res.redirect(url.toString());
  };

  if (!entry) {
    return redirectWithStatus("error", "Invalid or expired OAuth state");
  }
  pendingStates.delete(state!);

  try {
    // intuit-oauth's createToken expects the full callback URL (it parses
    // code/realmId/state off it internally).
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    // organizationId comes from the pendingStates entry (stored at
    // connect-time), NOT req.tenant -- this route has no tenant context, it
    // isn't behind requireTenantContext or even requireSignedIn.
    await saveConnectionFromCallback(entry.userId, entry.organizationId, fullUrl);
    return redirectWithStatus("connected");
  } catch (err) {
    req.log.error(err);
    return redirectWithStatus("error", "Failed to complete QuickBooks connection");
  }
});
