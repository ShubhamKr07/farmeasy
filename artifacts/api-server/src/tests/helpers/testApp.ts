import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from "express";

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
 *   const app = createAuthenticatedTestApp(shipmentsRouter);
 *   const res = await request(app).get("/api/shipments");
 */
export function createAuthenticatedTestApp(
  router: Router,
  user: { sub: string; user_role?: string } = DEFAULT_TEST_USER,
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
    next();
  });
  app.use("/api", router);
  return app;
}
