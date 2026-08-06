import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { supabaseAuthMiddleware, getAuth } from "./middlewares/supabaseAuth";
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
// browser here directly; can't carry our Bearer-token auth — see accounting.ts).
app.use("/api", healthRouter);
app.use("/api", accountingPublicRouter);

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
// The fix orders every mount into three tiers, each strictly before the
// next, so nothing later can ever be intercepted by something earlier:
//
//   1. Genuinely ungated, or gated only PER-ROUTE (a route-specific
//      middleware arg, e.g. `router.get("/x", requireTenantContext, ...)` in
//      growthProfiles.ts/seedLots.ts, or no tenant gate at all, e.g.
//      media.ts's `POST /media/upload`, which only checks `enforceAuth`) --
//      a per-route (or absent) gate only ever runs once that specific route
//      has already matched, so it can never intercept a request meant for
//      another router. Safe anywhere; order among these doesn't matter.
//   2. Self-gates via an unconditional `router.use(requireTenantContext)`
//      inside the router file itself (cycles.ts, facility-readiness.ts) --
//      this behaves exactly like an app.ts-level gate (see above), so it
//      must come after every tier-1 router but before tier 3.
//   3. Relies entirely on app.ts's own `requireTenantContext` wrap in its
//      mount call (alerts, inventory, shipments, badTrays, sensors, tasks,
//      metrics, accounting, facilityLogs) -- these never self-gate, so
//      nothing here may sit before an ungated/per-route-gated router.
//
// When adding a new router mount, place it in the earliest tier that
// applies -- never interleave a later tier ahead of an earlier one.

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

export default app;
