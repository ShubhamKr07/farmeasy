import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUri,
  saveConnectionFromCallback,
  getConnectionStatus,
  disconnect,
} from "../lib/accounting/quickbooks";

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
const pendingStates = new Map<string, { userId: string; expiresAt: number }>();

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

// ── Authenticated router (mount behind requireSignedIn) ────────────────────

export const accountingRouter = Router();

accountingRouter.get("/accounting/connect", (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  cleanupExpiredStates();
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, { userId: userId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const uri = getAuthorizeUri(state);
  return res.json({ authorizeUri: uri });
});

accountingRouter.get("/accounting/status", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const status = await getConnectionStatus(userId);
  return res.json(status);
});

accountingRouter.post("/accounting/disconnect", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const ok = await disconnect(userId);
  return res.json({ disconnected: ok });
});

// ── Public router (mount before requireSignedIn) ───────────────────────────

export const accountingPublicRouter = Router();

accountingPublicRouter.get("/accounting/callback", async (req: Request, res: Response) => {
  const state = req.query.state as string | undefined;
  const entry = state ? pendingStates.get(state) : undefined;

  const dashboardUrl = process.env.CORS_ORIGIN ?? "/";
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
    await saveConnectionFromCallback(entry.userId, fullUrl);
    return redirectWithStatus("connected");
  } catch (err) {
    req.log.error(err);
    return redirectWithStatus("error", "Failed to complete QuickBooks connection");
  }
});
