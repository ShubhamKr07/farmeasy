import { eq, ne, and } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  withTenantScope,
  organizationsTable,
  facilitiesTable,
  cyclesTable,
  growthProfilesTable,
  alertsTable,
} from "@workspace/db";

/**
 * Overdue-cycle alert scanner (R6 / I3).
 *
 * Previously this ran inside `GET /dashboard` (a write-on-read side effect with a
 * SELECT-then-INSERT race). It now runs as a scheduled job (startup + interval) so
 * the dashboard endpoint stays read-only. Alert inserts are idempotent via
 * `onConflictDoNothing`, backed by the partial unique index on
 * (title, location) where status = 'current'.
 */
export async function scanOverdueCyclesAndAlert(log?: Logger) {
  // Fetch every tenant (organizationId + facilityId pair) once, outside any
  // tenant scope. Each tenant is then scanned independently inside its own
  // withTenantScope transaction so RLS policies see the right app.org_id /
  // app.facility_id for that tenant's rows.
  const tenants = await db
    .select({
      organizationId: organizationsTable.id,
      facilityId: facilitiesTable.id,
    })
    .from(organizationsTable)
    .innerJoin(facilitiesTable, eq(facilitiesTable.organizationId, organizationsTable.id));

  let totalScanned = 0;
  let totalCreated = 0;

  for (const tenant of tenants) {
    const { scanned, created } = await withTenantScope(tenant, async (tx) => {
      const runningRows = await tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(
          growthProfilesTable,
          eq(cyclesTable.growthProfileId, growthProfilesTable.id),
        )
        .where(
          and(eq(cyclesTable.facilityId, tenant.facilityId), ne(cyclesTable.status, "completed")),
        );

      type ActionItem = {
        cycleId: number;
        cycleShortId: string;
        seedName: string;
        trayPosition: string | null;
        type: "fertigation" | "harvest";
        daysOverdue: number;
      };

      const actionRequired: ActionItem[] = [];
      const now = Date.now();

      for (const { cycle, profile } of runningRows) {
        if (!profile) continue;

        if (cycle.status === "germination" && cycle.germinationStartedAt) {
          const dueMs = cycle.germinationStartedAt.getTime() + profile.germinationDays * 864e5;
          if (now > dueMs) {
            actionRequired.push({
              cycleId: cycle.id,
              cycleShortId: cycle.shortId,
              seedName: cycle.seedName,
              trayPosition: cycle.trayPosition,
              type: "fertigation",
              daysOverdue: Math.floor((now - dueMs) / 864e5),
            });
          }
        } else if (cycle.status === "fertigation" && cycle.fertigationStartedAt) {
          const dueMs = cycle.fertigationStartedAt.getTime() + profile.fertigationDays * 864e5;
          if (now > dueMs) {
            actionRequired.push({
              cycleId: cycle.id,
              cycleShortId: cycle.shortId,
              seedName: cycle.seedName,
              trayPosition: cycle.trayPosition,
              type: "harvest",
              daysOverdue: Math.floor((now - dueMs) / 864e5),
            });
          }
        }
      }

      let created = 0;
      for (const item of actionRequired) {
        const title =
          item.type === "harvest"
            ? `Overdue Harvest: ${item.seedName}`
            : `Overdue Fertigation Transition: ${item.seedName}`;
        const location = item.trayPosition ?? `Cycle ${item.cycleShortId}`;

        const [inserted] = await tx
          .insert(alertsTable)
          .values({
            title,
            description: `Cycle #${item.cycleShortId} (${item.seedName}) is ${item.daysOverdue} day(s) overdue for ${item.type === "harvest" ? "harvesting" : "fertigation transition"}.`,
            severity: item.daysOverdue >= 3 ? "critical" : "warning",
            location,
            status: "current",
            actionType: item.type,
            facilityId: tenant.facilityId,
          })
          // onConflictDoNothing — idempotent inserts backed by the partial
          // unique index on (title, location) where status = 'current'.
          .onConflictDoNothing()
          .returning();

        if (inserted) created += 1;
      }

      return { scanned: runningRows.length, created };
    });

    totalScanned += scanned;
    totalCreated += created;
  }

  log?.info({ scanned: totalScanned, created: totalCreated }, "overdue scan complete");
  return { scanned: totalScanned, created: totalCreated };
}
