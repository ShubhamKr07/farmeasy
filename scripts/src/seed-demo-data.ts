/**
 * Seed demo data for FarmEasy development/demo environment.
 *
 * Delegates entirely to the canonical `seedDemoOrg` module (TEN-013) shared
 * with POST /api/demo/provision — see lib/db/src/seed/seedDemoOrg.ts for the
 * dataset itself (10 cycles spread across lifecycle stages, seed lots,
 * sensors, alerts, tasks, inventory, facility logs). This script's own job is
 * just to resolve an existing facility/org/owner to seed and to guard against
 * accidental production runs.
 *
 * Run:  pnpm --filter @workspace/scripts run seed-demo
 */

import { db, facilitiesTable, organizationMembersTable, withTenantScope, seedDemoOrg } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/**
 * seed_lots/cycles both gained a NOT NULL facilityId column in the tenancy-
 * scoping migrations (0018-0025) -- this dev-only demo-seeding script (never
 * run in CI, never exposed to real request traffic, so no RLS/
 * withTenantScope concerns apply to resolving the target) just needs any real
 * facility to seed. Takes the first one that exists; run the API server and
 * complete onboarding once before this script if none exist yet.
 */
async function getFacility(): Promise<{ facilityId: number; organizationId: number }> {
  const [facility] = await db
    .select({ id: facilitiesTable.id, organizationId: facilitiesTable.organizationId })
    .from(facilitiesTable)
    .limit(1);
  if (!facility) {
    throw new Error("No facility exists yet. Complete onboarding (POST /facilities) before running this script.");
  }
  return { facilityId: facility.id, organizationId: facility.organizationId };
}

/**
 * facility_logs.userId is NOT NULL, so seedDemoOrg needs a real user to
 * attribute its demo log rows to -- the facility's own owner, same as the
 * live POST /demo/provision endpoint resolves via getOwnerOrg.
 */
async function getOwnerUserId(organizationId: number): Promise<string> {
  const [owner] = await db
    .select({ userId: organizationMembersTable.userId })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.role, "owner"),
        eq(organizationMembersTable.status, "active"),
      ),
    )
    .limit(1);
  if (!owner) {
    throw new Error(`No active owner membership found for organization ${organizationId}.`);
  }
  return owner.userId;
}

async function main() {
  // This CLI writes real seed rows straight into whatever DATABASE_URL is
  // configured -- refuse to run against a production deploy by accident. The
  // live endpoint's own safety is tenant-scoping (POST /demo/provision only
  // ever seeds the caller's own org), not an env block; this guard is purely
  // the CLI's.
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run demo seed under NODE_ENV=production.");
    process.exit(1);
  }
  if (process.env.CONFIRM_DEMO_SEED !== "true") {
    console.error("Set CONFIRM_DEMO_SEED=true to run the demo seed.");
    process.exit(1);
  }

  const { facilityId, organizationId } = await getFacility();
  const userId = await getOwnerUserId(organizationId);

  console.log(`Seeding demo data into facility ${facilityId} (org ${organizationId})…`);
  await withTenantScope({ organizationId, facilityId }, (tx) =>
    seedDemoOrg(tx, { organizationId, facilityId, userId }),
  );
  console.log("Done.");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
