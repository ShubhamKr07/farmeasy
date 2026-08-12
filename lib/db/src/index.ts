import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { buildPoolConfig } from "./ssl";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// TLS posture lives in ./ssl (Release 1 Task 10): local/disposable Postgres
// (loopback, no SSL support) stays `ssl: false`; every hosted Supabase target
// is pinned to the `DATABASE_CA_CERT` root with `rejectUnauthorized: true`.
// The previous `rejectUnauthorized: false` encrypted the link but accepted
// any certificate — a live MITM gap that's now closed (fail-closed: a remote
// connection string with no DATABASE_CA_CERT throws rather than downgrade).
// buildPoolConfig also strips any `sslmode` from the URL first — pg would
// otherwise silently ignore the pinned `ssl` object (see ./ssl for the
// 2026-08-10 incident). Shared with scripts/migrate.mjs so the app pool and
// migrations never drift.
export const pool = new Pool(buildPoolConfig(connectionString));
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./scope.js";
export { seedDemoOrg } from "./seed/seedDemoOrg.js";
