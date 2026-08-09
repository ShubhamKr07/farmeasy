// scripts/ci/verify-db-role.mjs
// Checks whether the Postgres role in DATABASE_URL has BYPASSRLS -- if so,
// every RLS policy in this initiative is a silent no-op regardless of what
// it says (Supabase's default `postgres` and `service_role` roles both have
// BYPASSRLS by default). Run manually against staging before trusting any
// RLS policy written in this milestone:
//   DATABASE_URL=... node scripts/ci/verify-db-role.mjs
import pg from "pg";
import { buildSslConfig } from "../../lib/db/src/ssl.ts";

// Strip whitespace (Render pastes env vars line-wrapped; a URL contains none) —
// mirrors scripts/ci/check-migration-drift.mjs / verify-staging-supabase.mjs.
const connectionString = process.env.DATABASE_URL?.replace(/\s/g, "");
if (!connectionString) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

// CA-pinned TLS via the repo's shared buildSslConfig (reads DATABASE_CA_CERT):
// local/disposable -> ssl:false; hosted -> { ca, rejectUnauthorized:true }.
// Without this, connecting to a hosted Supabase pooler fails with
// SELF_SIGNED_CERT_IN_CHAIN because new pg treats sslmode=require as verify-full
// and Supabase's cert is signed by a private root not in the system trust store.
const client = new pg.Client({
  connectionString,
  ssl: buildSslConfig(connectionString),
});
await client.connect();
const { rows } = await client.query(
  "SELECT current_user AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user",
);
await client.end();

const { role, rolbypassrls } = rows[0];
console.log(`Connected as: ${role}`);
console.log(`BYPASSRLS: ${rolbypassrls}`);
if (rolbypassrls) {
  console.log(
    "\nThis role bypasses RLS entirely -- every policy written in this milestone " +
      "is a no-op under this connection. A new least-privilege role must be " +
      "provisioned and DATABASE_URL rotated to it before RLS is trustworthy. " +
      "See docs/runbooks/tenancy-db-role.md.",
  );
  process.exit(1);
}
console.log("\nThis role does not bypass RLS -- policies will be enforced.");
