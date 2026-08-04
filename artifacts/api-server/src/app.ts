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
app.use("/api", requireSignedIn, dashboardRouter);
app.use("/api", requireSignedIn, requireTenantContext, alertsRouter);
app.use("/api", requireSignedIn, inventoryRouter);
app.use("/api", requireSignedIn, requireTenantContext, shipmentsRouter);
app.use("/api", requireSignedIn, badTraysRouter);
app.use("/api", requireSignedIn, cyclesRouter);
app.use("/api", requireSignedIn, layoutRouter);
app.use("/api", requireSignedIn, sensorsRouter);
app.use("/api", requireSignedIn, sensorReadingsRouter);
app.use("/api", requireSignedIn, requireTenantContext, tasksRouter);
app.use("/api", requireSignedIn, cropsRouter);
app.use("/api", requireSignedIn, metricsRouter);
app.use("/api", requireSignedIn, userSettingsRouter);
app.use("/api", requireSignedIn, accountingRouter);
app.use("/api", requireSignedIn, recommendRouter);
app.use("/api", requireSignedIn, facilityLogsRouter);
app.use("/api", requireSignedIn, facilitiesRouter);
app.use("/api", requireSignedIn, wizardRouter);
app.use("/api", requireSignedIn, sensorAccountsRouter);
app.use("/api", requireSignedIn, facilityReadinessRouter);
app.use("/api", requireSignedIn, wizardEventsRouter);
app.use("/api", requireSignedIn, router);

export default app;
