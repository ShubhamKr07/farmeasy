import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from "express";
import pino from "pino";
import { resolveTenantContext } from "../../middlewares/tenantContext";

// This harness never mounts pino-http (app.ts does), so req.log was
// undefined -- invisible while every route's catch block only ran on
// expected 4xx paths, but a real pino instance is needed so an unexpected
// error's own req.log.error(err) call surfaces the error instead of itself
// throwing "Cannot read properties of undefined (reading 'error')" and
// masking whatever actually failed.
const testLogger = pino({ level: "error" });

/**
 * Identity the harness injects on every request when a test passes no
 * override. A technician — the role most routes serve — so default-scoped
 * route tests don't have to repeat it. Tests asserting role-gated behavior
 * (facility_lead/supervisor/quality_lead-only routes) pass the second `user`
 * argument to createAuthenticatedTestApp.
 */
export const DEFAULT_TEST_USER = {
  sub: "00000000-0000-4000-8000-000000000001",
  user_role: "technician",
} as const;

/**
 * Build a standalone Express app for supertest that mirrors the production
 * wiring in app.ts — JSON body parsing, request identity, and `router`
 * mounted under `/api` — but with a test double in place of real auth.
 *
 * Instead of running `supabaseAuthMiddleware` (which verifies a live JWT
 * against Supabase's remote JWKS), a tiny middleware sets `req.supabaseUser`
 * directly from `user`. That mirrors the real `supabaseUser` shape
 * (src/middlewares/supabaseAuth.ts:21-28) so route handlers and `getAuth`
 * behave exactly as in production. This is a test double for auth, not a
 * bypass of the production app: app.ts and its real middleware chain are
 * never touched.
 *
 * `facilityId`, when provided, is injected as an `X-Facility-Id` request
 * header the same way — a test double standing in for the real client
 * header TEN-008's resolveTenantContext now requires on every
 * facility-scoped request, not a bypass of that resolver (it still runs for
 * real and still re-validates the value against real
 * organization_members/facilities rows). Omit it for routes that are
 * genuinely org-scoped or pre-facility-existence (sensor-accounts,
 * facilities, wizard progress) and don't need it.
 *
 *   const app = createAuthenticatedTestApp(shipmentsRouter, DEFAULT_TEST_USER, facilityId);
 *   const res = await request(app).get("/api/shipments");
 */
export function createAuthenticatedTestApp(
  router: Router,
  user: { sub: string; user_role?: string } = DEFAULT_TEST_USER,
  facilityId?: number,
): Express {
  const app = express();
  // Mirror app.ts: parse JSON bodies before route handlers consume them.
  app.use(express.json());
  // Test double for supabaseAuthMiddleware: attach identity verbatim.
  // Mounted before the router so every handler sees req.supabaseUser, just as
  // requireSignedIn (app.ts) sees it after the real middleware populates it
  // from a verified token.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.supabaseUser = user;
    req.log = testLogger;
    if (facilityId !== undefined) {
      req.headers["x-facility-id"] = String(facilityId);
    }
    next();
  });
  app.use(resolveTenantContext);
  app.use("/api", router);
  return app;
}
