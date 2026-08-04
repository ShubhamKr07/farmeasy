import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { buildSslConfig } from "./ssl";

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
// Shared with scripts/migrate.mjs so the app pool and migrations never drift.
export const pool = new Pool({
  connectionString,
  ssl: buildSslConfig(connectionString),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./scope.js";
