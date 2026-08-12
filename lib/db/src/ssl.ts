import type { PoolConfig } from "pg";

/**
 * True when `connectionString` points at a loopback / disposable Postgres
 * instance — Docker, e.g. Supabase's local dev stack used by
 * scripts/ci/test-disposable-supabase.sh. Those instances don't offer SSL at
 * all (forcing it throws "The server does not support SSL connections"), so
 * they're the only target where `ssl: false` is correct. Every hosted
 * Supabase target supports and expects SSL.
 *
 * Strips the `user:pass@` userinfo first so a non-loopback host with a
 * loopback-looking password isn't misclassified; the host is what we test.
 */
export function isLocalDatabase(connectionString: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:|\/)/.test(
    connectionString.replace(/^postgres(ql)?:\/\/[^@]*@/, ""),
  );
}

/**
 * Build the `ssl` option for `new Pool(...)` / `new Client(...)`.
 *
 * Release 1 Task 10 closed a live MITM gap: the previous code used
 * `{ rejectUnauthorized: false }` for every remote connection — the link was
 * encrypted but accepted ANY certificate, including a forged one presented by
 * a man-in-the-middle attacker. Non-local connections now require a CA-pinned
 * root (`DATABASE_CA_CERT`, the shared "Supabase Root 2021 CA") with strict
 * validation (`rejectUnauthorized: true`); local/disposable Postgres stays
 * `ssl: false`.
 *
 * Fail-closed: a non-local connection string with no `DATABASE_CA_CERT`
 * throws rather than silently downgrading to insecure TLS. Supabase's
 * Postgres cert is signed by a private root not in the system trust store, so
 * a bare `rejectUnauthorized: true` (no `ca`) would fail TLS anyway — throwing
 * here surfaces a clear, actionable message instead of a confusing handshake
 * error. This mirrors the codebase's existing fail-closed conventions
 * (CORS_ORIGINS in production, TRUST_PROXY_HOPS).
 *
 * Shared by lib/db/src/index.ts (the app's runtime pool) and
 * lib/db/scripts/migrate.mjs (CI + deploy migration runs) so the two never
 * drift on TLS posture.
 */
export function buildSslConfig(connectionString: string): PoolConfig["ssl"] {
  if (isLocalDatabase(connectionString)) {
    return false;
  }
  const ca = process.env.DATABASE_CA_CERT;
  if (!ca) {
    throw new Error(
      "DATABASE_CA_CERT must be set for non-local database connections — " +
        "Release 1 Task 10 requires CA-pinned TLS. The prior " +
        "rejectUnauthorized:false accepted forged/MITM certificates; " +
        "set DATABASE_CA_CERT to the PEM-encoded Supabase Root 2021 CA.",
    );
  }
  return { ca, rejectUnauthorized: true };
}

/**
 * Remove any `sslmode` query parameter from a Postgres connection string.
 *
 * node-postgres parses a connection string's `sslmode` (via pg-connection-string)
 * into its own `ssl` value that SILENTLY OVERWRITES the explicit `ssl` object
 * passed to `new Pool({ connectionString, ssl })`. That drops the CA-pinned
 * config from `buildSslConfig` and lets pg fall back to the system trust store,
 * which does NOT contain Supabase's private Root 2021 CA — so strict TLS then
 * fails with "self-signed certificate in certificate chain", and a permissive
 * `sslmode` would instead silently downgrade the pinning, defeating Release-1
 * Task-10's MITM protection outright.
 *
 * Real production incident (2026-08-10): prod `DATABASE_URL` carried
 * `?sslmode=require` while staging did not — prod's CA-pinned TLS was inert and
 * the API's DB path was down ~34h; staging (no `sslmode`) was fine.
 *
 * Stripping the param makes our explicit `ssl` config the single source of
 * truth for TLS posture regardless of what the env-provided URL contains. Any
 * other query params are preserved.
 */
export function stripSslmode(connectionString: string): string {
  const q = connectionString.indexOf("?");
  if (q === -1) return connectionString;
  const base = connectionString.slice(0, q);
  const kept = connectionString
    .slice(q + 1)
    .split("&")
    .filter((p) => p !== "" && !/^sslmode=/i.test(p));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

/**
 * Single source of truth for a Postgres pool's connection + TLS options. Binds
 * `sslmode`-stripping to the ssl build so the two can never drift: any
 * `sslmode` in the env URL is removed BEFORE both the returned
 * `connectionString` and the `ssl` config are derived, guaranteeing
 * `buildSslConfig`'s CA-pinned `ssl` object actually reaches the socket. Use
 * this at every `new Pool(...)` call site (src/index.ts, scripts/migrate.mjs)
 * instead of wiring `connectionString` + `buildSslConfig` separately.
 */
export function buildPoolConfig(connectionString: string): {
  connectionString: string;
  ssl: PoolConfig["ssl"];
} {
  const sanitized = stripSslmode(connectionString);
  return { connectionString: sanitized, ssl: buildSslConfig(sanitized) };
}
