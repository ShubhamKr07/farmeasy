import type { CorsOptions } from "cors";

/**
 * CORS origin configuration (Release 1 Task 9, Steps 2-3).
 *
 * Replaces the legacy single-value `CORS_ORIGIN` env var. Origins are now a
 * comma-separated list (`CORS_ORIGINS`) because the API is reached from more
 * than one browser origin (production dashboard, staging dashboard, preview
 * deploys), and the QuickBooks OAuth callback redirect no longer reuses this
 * variable — it has its own `DASHBOARD_URL` (see `routes/accounting.ts`).
 *
 * Fail-closed in production: if `CORS_ORIGINS` is empty/unset under
 * `NODE_ENV=production`, `buildCorsOptions` throws so the process refuses to
 * start rather than silently allowing every origin (the old
 * `origin ?? true` default) or none. Non-production keeps the permissive
 * default (empty list -> allow all) so local dev and tests don't need to
 * configure the var.
 */

/**
 * Parse `CORS_ORIGINS` into a list of exact browser origins.
 *
 * Comma-separated; whitespace around each entry is trimmed and empty entries
 * are dropped, so `"https://a.example.com, https://b.example.com,"` parses to
 * a clean two-element list. Origins are matched exactly downstream (no
 * substring/regex), so each entry must be the full scheme://host[:port].
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the `cors` package's function-form `origin` option.
 *
 * Requests with NO `Origin` header (native mobile apps, server-to-server
 * calls) are allowed unconditionally: CORS only governs browser-originated
 * cross-origin requests, which always send an `Origin` header, and the `cors`
 * package invokes this callback with `undefined` for the no-Origin case.
 * When an `Origin` header IS present, the request is accepted only if that
 * exact origin appears in `allowedOrigins`.
 */
export function corsOriginValidator(allowedOrigins: readonly string[]) {
  const set = new Set(allowedOrigins);
  return (
    requestOrigin: string | undefined,
    callback: (err: Error | null, origin?: boolean | string) => void,
  ): void => {
    if (requestOrigin === undefined) {
      callback(null, true);
      return;
    }
    callback(null, set.has(requestOrigin));
  };
}

/**
 * Build cors options from the given environment (defaults to `process.env`).
 *
 * Throws under `NODE_ENV=production` when `CORS_ORIGINS` is empty/unset —
 * fail-closed at startup. `app.ts` calls this at module load (server boot),
 * so a misconfigured production deploy crashes instead of serving with an
 * open or empty CORS policy. The `env` parameter lets tests drive the
 * production/dev branches without mutating global `process.env`.
 */
export function buildCorsOptions(
  env: NodeJS.ProcessEnv = process.env,
): CorsOptions {
  const allowed = parseCorsOrigins(env.CORS_ORIGINS);
  if (env.NODE_ENV === "production" && allowed.length === 0) {
    throw new Error(
      "CORS_ORIGINS must be set to a comma-separated list of allowed browser origins in production (NODE_ENV=production).",
    );
  }
  return { origin: corsOriginValidator(allowed) };
}
