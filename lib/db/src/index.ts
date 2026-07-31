import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Local/disposable Postgres (Docker, e.g. Supabase's local dev stack used by
// scripts/ci/test-disposable-supabase.sh) doesn't offer SSL at all -- forcing
// it here throws "The server does not support SSL connections" and the
// connection never opens. Every real (hosted Supabase) target does support
// and expect SSL, so this only relaxes local/loopback connections; remote
// behavior is unchanged. (Proper CA-validated TLS is Release 1 Task 10 --
// this preserves today's rejectUnauthorized:false for everything remote.)
const isLocalDatabase = /^(localhost|127\.0\.0\.1)(:|\/)/.test(
  connectionString.replace(/^postgres(ql)?:\/\/[^@]*@/, ""),
);

export const pool = new Pool({
  connectionString,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
});
export const db = drizzle(pool, { schema });

export * from "./schema";
