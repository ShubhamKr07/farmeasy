/**
 * Express `trust proxy` configuration (Release 1 Task 9, Step 5).
 *
 * `req.ip` — and therefore the IP-keyed recommendation rate limiter in
 * `routes/recommend.ts` — is only trustworthy when Express is told EXACTLY
 * how many reverse-proxy hops to trust for `X-Forwarded-For` parsing.
 * FarmSmart's API runs behind Render's single edge proxy in production → 1
 * hop. Without an explicit hop count Express trusts NO proxy, so `req.ip`
 * would be the edge proxy's own address (identical for every client) and
 * per-IP rate limiting would collapse to a single shared bucket; set too
 * high and any client can spoof its IP via a forged left-most
 * `X-Forwarded-For` entry (the proxy appends the real client on the right,
 * so trusting N>real-hops reaches into attacker-controlled territory).
 *
 * Fail-closed in production: a missing/non-positive-integer
 * `TRUST_PROXY_HOPS` under `NODE_ENV=production` throws at startup (same
 * pattern as `buildCorsOptions` in lib/cors.ts — the process refuses to
 * boot rather than silently trusting the wrong number of hops). Outside
 * production the var is optional; `resolveTrustProxy` then returns
 * `undefined` and `app.ts` leaves Express's default (trust no proxy) in
 * place so local/test loopback traffic is unaffected.
 */

/**
 * Parse `TRUST_PROXY_HOPS` into a positive-integer hop count.
 *
 * Returns `undefined` when the value is unset/empty (caller decides whether
 * that is fatal — see `resolveTrustProxy`). Throws for any present-but-
 * malformed value (non-integer, non-positive, leading "+", etc.): a
 * malformed hop count is a configuration error, not a "fall back to a
 * default" case — silently defaulting in production could mean trusting the
 * wrong number of hops, which is the exact footgun this module exists to
 * prevent.
 */
export function parseTrustProxyHops(
  raw: string | undefined,
): number | undefined {
  // Unset OR whitespace-only → undefined (caller decides whether that is
  // fatal — see `resolveTrustProxy`).
  if (!raw || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  // Positive integers only: "+1", "1.0", "1e0", "0x1" are all rejected so the
  // value can't be misread by Number()'s coercion.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  const hops = Number(trimmed);
  if (!Number.isSafeInteger(hops) || hops < 1) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a positive integer >= 1 (got ${JSON.stringify(raw)})`,
    );
  }
  return hops;
}

/**
 * Resolve the Express `trust proxy` value from the environment.
 *
 * Throws under `NODE_ENV=production` when `TRUST_PROXY_HOPS` is unset/empty
 * — fail-closed at startup (mirrors `buildCorsOptions`). A present-but-
 * malformed value throws via `parseTrustProxyHops` regardless of NODE_ENV.
 *
 * The `env` parameter lets unit tests drive the production/dev branches
 * without mutating global `process.env`, mirroring `buildCorsOptions`.
 *
 * @returns the positive-integer hop count, or `undefined` (non-production
 *          with the var unset) — in which case `app.ts` leaves Express's
 *          default (trust no proxy) in place.
 */
export function resolveTrustProxy(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const hops = parseTrustProxyHops(env.TRUST_PROXY_HOPS);
  if (env.NODE_ENV === "production" && hops === undefined) {
    throw new Error(
      "TRUST_PROXY_HOPS must be set to a positive integer in production (NODE_ENV=production). " +
        "FarmSmart's API is single-hop behind Render's edge proxy, so use \"1\".",
    );
  }
  return hops;
}
