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

// SSL posture. Default = the repo's CA-pinned buildSslConfig (reads
// DATABASE_CA_CERT): local/disposable -> ssl:false; hosted -> { ca,
// rejectUnauthorized:true }.
//
// Exception — DB_ROLE_CHECK_INSECURE_TLS=true: the hosted Supabase TRANSACTION
// pooler (Supavisor, :6543) presents a certificate that is NOT chained to the
// Root-2021 CA that covers the DIRECT connection, so CA-pinning against that
// root fails there with SELF_SIGNED_CERT_IN_CHAIN. This script only reads a
// single pg_roles flag (rolbypassrls) and moves NO user data, so for the
// pooler role-check we allow encrypted-but-unverified TLS behind an explicit,
// opt-in env flag that is set ONLY in .github/workflows/verify-prod-db-role.yml.
// The application's real data path keeps strict CA-pinning (lib/db/src/ssl.ts);
// this flag never touches it.
const insecureTls = process.env.DB_ROLE_CHECK_INSECURE_TLS === "true";
let ssl;
if (insecureTls) {
  console.warn(
    "⚠ DB_ROLE_CHECK_INSECURE_TLS=true — TLS is encrypted but the server " +
      "certificate is NOT verified. Permitted here only because this check reads " +
      "one role attribute and moves no data; never use this for a data path.",
  );
  ssl = { rejectUnauthorized: false };
} else {
  ssl = buildSslConfig(connectionString);
}

const client = new pg.Client({ connectionString, ssl });
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
