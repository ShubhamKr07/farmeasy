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
