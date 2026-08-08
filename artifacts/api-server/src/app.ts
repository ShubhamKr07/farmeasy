import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { supabaseAuthMiddleware, getAuth } from "./middlewares/supabaseAuth";
import { requireVerifiedEmail } from "./middlewares/requireVerifiedEmail";
import { resolveTenantContext, requireTenantContext } from "./middlewares/tenantContext";
import router from "./routes";
import healthRouter from "./routes/health";
import dashboardRouter from "./routes/dashboard";
import alertsRouter from "./routes/alerts";
import inventoryRouter from "./routes/inventory";
import shipmentsRouter from "./routes/shipments";
import badTraysRouter from "./routes/badTrays";
import cyclesRouter from "./routes/cycles";
import layoutRouter from "./routes/layout";
import sensorsRouter from "./routes/sensors";
import sensorReadingsRouter from "./routes/sensor-readings";
import tasksRouter from "./routes/tasks";
import cropsRouter from "./routes/crops";
import metricsRouter from "./routes/metrics";
import userSettingsRouter from "./routes/userSettings";
import { accountingRouter, accountingPublicRouter } from "./routes/accounting";
import recommendRouter from "./routes/recommend";
import facilityLogsRouter from "./routes/facilityLogs";
import facilitiesRouter from "./routes/facilities";
import wizardRouter from "./routes/wizard";
import sensorAccountsRouter from "./routes/sensor-accounts";
import facilityReadinessRouter from "./routes/facility-readiness";
import wizardEventsRouter from "./routes/wizard-events";
import invitationsRouter from "./routes/invitations";
import invitationsAcceptRouter from "./routes/invitationsAccept";
import membersRouter from "./routes/members";
import { createAuthRouter } from "./routes/auth";
import { logger } from "./lib/logger";
import { buildCorsOptions } from "./lib/cors";
import { resolveTrustProxy } from "./lib/trustProxy";

// Bounded client-version extraction for request logging. The mobile app
// advertises its version via `X-FarmSmart-Client-Version` (see custom-fetch).
// We record a bounded form so per-version adoption can be measured for the
// mobile update promotion gate without allowing arbitrary-length / log-
// injection payloads to bloat or forge logs. Empty/absent -> not logged.
const MAX_CLIENT_VERSION_LEN = 32;
function boundedClientVersion(req: Request): string | undefined {
  const raw = req.headers["x-farmsmart-client-version"];
  if (!raw) return undefined;
  const value = String(raw).trim().slice(0, MAX_CLIENT_VERSION_LEN);
  return value === "" ? undefined : value;
}

const app: Express = express();

// Trust proxy: production requires an explicit positive-integer hop count
// (TRUST_PROXY_HOPS) so `req.ip` reflects the real client behind Render's
// edge proxy. The IP-keyed recommendation rate limiter (routes/recommend.ts)
// is only sound when `req.ip` can't be spoofed via a forged left-most
// X-Forwarded-For entry — resolveTrustProxy throws at startup in production
// when unset/invalid (fail-closed, same pattern as CORS_ORIGINS). Outside
// production the var is optional; when unset we leave Express's default
// (trust no proxy) in place so local/test loopback traffic is unaffected.
const trustProxyHops = resolveTrustProxy();
if (trustProxyHops !== undefined) {
  app.set("trust proxy", trustProxyHops);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        const clientVersion = boundedClientVersion(req);
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
          ...(clientVersion ? { clientVersion } : {}),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS: production requires CORS_ORIGINS (comma-separated browser origins);
// buildCorsOptions throws at startup if it's unset under NODE_ENV=production
// (fail-closed). Requests with no Origin header (native mobile, server-to-
// server) are allowed unconditionally — see lib/cors.ts.
app.use(cors(buildCorsOptions()));
// 1 MiB JSON body limit (Task 9 Step 4). Recommendation questions are
// capped at 2,000 chars in routes/recommend.ts and every other JSON route
// sends small payloads; 20 MiB was an over-large global default that let a
// single request pin ~20 MiB of parse buffer. Multipart upload
// (routes/media.ts) is unaffected — multer parses multipart bodies itself and
// keeps its own route-specific 5 MiB limit.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(supabaseAuthMiddleware);
app.use(resolveTenantContext);

function requireSignedIn(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Public: health check + QuickBooks OAuth callback (Intuit redirects the
// browser here directly; can't carry our Bearer-token auth — see accounting.ts)
// + POST /invitations/accept (TEN-010 T6: the invitee has no session yet —
// they're POSTing {token, password} to CREATE their account, so this must NOT
// sit behind requireSignedIn; see invitationsAccept.ts's own doc comment).
// + createAuthRouter (TEN-012 Task 9: GET /auth/signup-availability +
// POST /auth/request-access) — a brand-new prospective user with no account
// yet hits these BEFORE they can possibly have a session, so they must mount
// PUBLIC, above the requireSignedIn/requireVerifiedEmail gate below.
app.use("/api", healthRouter);
app.use("/api", accountingPublicRouter);
app.use("/api", invitationsAcceptRouter);
app.use("/api", createAuthRouter());

// Backend email-verification gate (TEN-012 Task 6) — defense-in-depth.
// Registered as a standalone `/api` middleware AFTER every PUBLIC router above
// (health / accounting OAuth callback / invitations-accept / auth
// signup-availability+request-access — a brand-new prospective user with no
// session yet must reach these, so they can't sit behind this gate) and BEFORE
// every requireSignedIn-gated tier below. Because each public router responds
// and does NOT call next() for the paths it owns, a request to a public path
// never reaches this line; every OTHER /api request falls through to here.
// requireSignedIn runs first (401 for no/invalid token — an unauthenticated
// caller has no verification claim to check anyway), then requireVerifiedEmail
// 403s only when the JWT claim is explicitly `false` (absent claim passes
// through — see the middleware's own doc comment). A VERIFIED user passes
// straight through to the tiers below, so the wizard bootstrap
// (GET /wizard/progress, tier 1) stays reachable for them.
app.use("/api", requireSignedIn, requireVerifiedEmail);

// Everything else requires a signed-in Clerk session (S1/S2). Per-route
// `enforceAuth` handlers in cycles/media remain as defense-in-depth.
//
// ORDERING MATTERS HERE. Express's `app.use(path, mw1, mw2, router)` runs
// `mw1`/`mw2` for EVERY request whose path matches `path` (a prefix match)
// that reaches that point in the stack -- not just requests `router` itself
// would actually handle. Every mount below shares the same "/api" prefix, so
// it matches every request. When a router has no matching internal route it
// calls `next()` and falls through to the NEXT `app.use(...)` in
// registration order -- but a short-circuiting middleware (like
// `requireTenantContext`, which sends a 400 instead of calling `next()`)
// already ran unconditionally before that happened, for a router it wasn't
// even mounted for. A request destined for a LATER router mounted with a
// *weaker* gate (or none) can therefore get intercepted and rejected by an
// EARLIER router's stronger gate -- this broke first-time onboarding
// (`POST /facilities` et al.) for any brand-new user whose request happened
// to fall through an earlier alerts/inventory/shipments/... mount first.
// The exact same hazard applies to a router's OWN internal `router.use(mw)`
// (no path) -- it too runs unconditionally for every request that reaches
// that router's mount, matched route or not (verified directly: an
// unrelated, later-mounted router's request got a 400 from an earlier
// router's unrelated `router.use(requireTenantContext)`), so a self-gating
// router is just as capable of blocking a *different*, later-mounted router
// as an app.ts-level gate is.
//
// The fix orders every mount into FOUR tiers, each strictly before the
// next, so nothing later can ever be intercepted by something earlier:
//
//   1. Genuinely ungated, or gated only PER-ROUTE (a route-specific
//      middleware arg, e.g. `router.get("/x", requireTenantContext, ...)` in
//      growthProfiles.ts/seedLots.ts, or no tenant gate at all, e.g.
//      media.ts's `POST /media/upload`, which only checks `enforceAuth`) --
//      a per-route (or absent) gate only ever runs once that specific route
//      has already matched, so it can never intercept a request meant for
//      another router. Safe anywhere; order among these doesn't matter.
//
//      NOTE: invitationsAccept.ts (TEN-010 T6, `POST /invitations/accept`) is
//      mounted even earlier than this, as fully PUBLIC (alongside
//      healthRouter/accountingPublicRouter, with no `requireSignedIn` at
//      all) -- the invitee has no session yet, so it can't be tier 1 either.
//   2. Self-gates TENANT CONTEXT ONLY via an unconditional
//      `router.use(requireTenantContext)` inside the router file itself
//      (cycles.ts, facility-readiness.ts) -- this behaves exactly like an
//      app.ts-level `requireTenantContext` wrap (see above), so it must come
//      after every tier-1 router but before tier 3. Crucially, this gate
//      rejects nothing that a signed-in tenant member of ANY role wouldn't
//      already be rejected for, so it's safe to sit ahead of every other
//      router in tiers 3-4.
//   3. Relies entirely on app.ts's own `requireTenantContext` wrap in its
//      mount call (alerts, inventory, shipments, badTrays, sensors, tasks,
//      metrics, accounting, facilityLogs) -- these never self-gate, so
//      nothing here may sit before an ungated/per-route-gated router.
//   4. Self-gates TENANT CONTEXT **+ A RESTRICTIVE ROLE** via an
//      unconditional `router.use(requireTenantContext, requireRole(...))`
//      inside the router file itself (invitations.ts [TEN-010 T5], members.ts
//      [TEN-010 T7], both owner/admin-only). This is NOT interchangeable with
//      tier 2 even though both "self-gate": a role-restrictive self-gate 403s
//      a valid tenant member (e.g. a technician) who has every right to reach
//      a DIFFERENT, later-mounted router -- tried mounting these in tier 2
//      and verified broken (a technician's `GET /api/alerts` came back 403
//      ROLE_FORBIDDEN, intercepted before ever reaching alertsRouter). So
//      tier 4 must come after EVERY router any non-owner/admin tenant member
//      is allowed to reach -- i.e. after all of tiers 1-3, not just tier 1.
//
// When adding a new router mount: if it self-gates on a RESTRICTIVE ROLE (not
// just tenant context), it belongs in tier 4, last -- never interleave it
// ahead of tiers 1-3. Otherwise, place it in the earliest tier that applies.

// Tier 1: ungated, or gated per-route only.
app.use("/api", requireSignedIn, dashboardRouter);
app.use("/api", requireSignedIn, layoutRouter);
app.use("/api", requireSignedIn, sensorReadingsRouter);
app.use("/api", requireSignedIn, cropsRouter);
app.use("/api", requireSignedIn, userSettingsRouter);
app.use("/api", requireSignedIn, recommendRouter);
app.use("/api", requireSignedIn, facilitiesRouter);
app.use("/api", requireSignedIn, wizardRouter);
app.use("/api", requireSignedIn, sensorAccountsRouter);
app.use("/api", requireSignedIn, wizardEventsRouter);
// Generic catch-all router (routes/index.ts: health/dashboard/layout
// re-mounted, plus growthProfiles/seedLots, both gated per-route only, plus
// media.ts's `POST /media/upload`, which carries no tenant gate at all --
// only `enforceAuth`). Every route this bundle actually handles is tier-1 by
// the rule above, so it belongs here, not after tier 2/3: mounting it last
// (as ordinary Express most-specific-first convention, which is what this
// mount previously did) put every tier-2/tier-3 requireTenantContext-gated
// router ahead of it, so a request to `/api/media/upload` with no/invalid
// X-Facility-Id was 400'd by an EARLIER router's gate before ever reaching
// media.ts's own (gate-less) handler -- the same interception class this
// whole reorder exists to prevent, just missed here because the bundle was
// treated as "tier 1 in substance" without checking media.ts's own gating
// individually. There is no ordering dependency forcing it last -- it mounts
// concrete paths (`/growth-profiles`, `/seed-lots/lookup`,
// `/media/upload`, ...), not a wildcard/catch-all pattern that needs to lose
// to more specific routes.
app.use("/api", requireSignedIn, router);

// Tier 2: self-gate internally via router.use(requireTenantContext) --
// behaves like an app.ts-level gate, so must follow all of tier 1.
app.use("/api", requireSignedIn, requireTenantContext, cyclesRouter); // requireTenantContext here is redundant with cycles.ts's own router.use(requireTenantContext), kept as-is per the no-gate-changes scope of this fix
app.use("/api", requireSignedIn, facilityReadinessRouter); // self-gates via router.use(requireTenantContext); no app.ts-level wrap

// Tier 3: rely entirely on app.ts's own requireTenantContext wrap.
app.use("/api", requireSignedIn, requireTenantContext, alertsRouter);
app.use("/api", requireSignedIn, requireTenantContext, inventoryRouter);
app.use("/api", requireSignedIn, requireTenantContext, shipmentsRouter);
app.use("/api", requireSignedIn, requireTenantContext, badTraysRouter);
app.use("/api", requireSignedIn, requireTenantContext, sensorsRouter);
app.use("/api", requireSignedIn, requireTenantContext, tasksRouter);
app.use("/api", requireSignedIn, requireTenantContext, metricsRouter);
app.use("/api", requireSignedIn, requireTenantContext, accountingRouter);
app.use("/api", requireSignedIn, requireTenantContext, facilityLogsRouter);

// Tier 4: self-gate internally via router.use(requireTenantContext,
// requireRole("owner","admin")) (TEN-010 invitations.ts/members.ts). This is
// NOT the same hazard class as tier 2's self-gates: tier 2's
// requireTenantContext-only self-gate rejects nothing that a legitimate
// signed-in tenant member (any role) shouldn't already be rejected for, so it
// only needed to sit after tier 1. A requireRole("owner","admin") self-gate is
// stricter -- it 403s a valid technician who has every right to reach a
// DIFFERENT, later-mounted router. Placing invitations/members in tier 2
// (immediately after facility-readiness, before tier 3) was tried and
// verified broken: a technician's `GET /api/alerts` came back 403
// ROLE_FORBIDDEN instead of 200, because invitations.ts's unconditional
// `router.use(requireRole(...))` -- which runs for every request that reaches
// that mount point, matched by this router or not, per the ordering hazard
// documented above -- intercepted it before alertsRouter ever ran. So these
// two must come after EVERY router any non-owner/admin tenant member (i.e.
// any technician) is allowed to reach -- that's all of tier 1, 2, AND 3.
// Their own routes (/invitations, /members) don't collide with any earlier
// router's paths, so nothing here is ever itself shadowed by an earlier
// mount.
app.use("/api", requireSignedIn, invitationsRouter); // self-gates via router.use(requireTenantContext, requireRole("owner","admin")); no app.ts-level wrap
app.use("/api", requireSignedIn, membersRouter); // self-gates via router.use(requireTenantContext, requireRole("owner","admin")); no app.ts-level wrap

export default app;
