// scripts/ci/verify-db-role.mjs
// Checks whether the Postgres role in DATABASE_URL has BYPASSRLS -- if so,
// every RLS policy in this initiative is a silent no-op regardless of what
// it says (Supabase's default `postgres` and `service_role` roles both have
// BYPASSRLS by default). Run manually against staging before trusting any
// RLS policy written in this milestone:
//   DATABASE_URL=... node scripts/ci/verify-db-role.mjs
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
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
