// Applies pending Drizzle migrations from ./drizzle to the configured database.
// Run: DATABASE_URL=... node scripts/migrate.mjs   (or `pnpm --filter @workspace/db run db:migrate`)
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
// SSL posture is shared with src/index.ts via src/ssl.ts (Release 1 Task 10):
// CA-pinned TLS for hosted Supabase, `ssl: false` for local/disposable
// Postgres. Node 22.18+ strips the type-only annotations in ssl.ts when this
// .mjs imports it, so no separate build step is needed. The deploy workflows
// set DATABASE_CA_CERT alongside DATABASE_URL_DIRECT for remote runs.
import { buildSslConfig } from "../src/ssl.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set to run migrations");
}

const { Pool } = pg;
const pool = new Pool({
  connectionString,
  ssl: buildSslConfig(connectionString),
});
const db = drizzle(pool);

try {
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../drizzle"),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
  console.log("✓ migrations applied");
} catch (err) {
  console.error("✗ migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
