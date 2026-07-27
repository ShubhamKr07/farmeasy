import { readFileSync } from "node:fs";
import { db } from "@workspace/db";
import {
  cyclesTable,
  manualChecksTable,
  tasksTable,
  badTrayEntriesTable,
  stockMovementsTable,
  userSettingsTable,
  accountingConnectionsTable,
  recommenderQueriesTable,
  facilityLogsTable,
} from "@workspace/db/schema";
import { sql, eq } from "drizzle-orm";

type MappingEntry = { clerkUserId: string; supabaseUserId: string };

async function main() {
  const mapping: MappingEntry[] = JSON.parse(
    readFileSync("clerk-user-mapping.json", "utf8"),
  );

  // The five created_by-derived columns are already `uuid`-typed (Task 2)
  // but hold NULL for every row created before this migration, since
  // Task 2's generated migration only converted the type — it never had
  // Clerk ID strings to map in the first place (created_by predates any
  // requirement to backfill). Nothing to do for those five here.

  // The four clerk_user_id-derived columns are still `text`-typed
  // (Task 2 Step 2 deliberately deferred their conversion to here).
  for (const { clerkUserId, supabaseUserId } of mapping) {
    await db.update(userSettingsTable)
      .set({ userId: sql`${supabaseUserId}::uuid` })
      .where(eq(userSettingsTable.userId as any, clerkUserId));
    await db.update(accountingConnectionsTable)
      .set({ userId: sql`${supabaseUserId}::uuid` })
      .where(eq(accountingConnectionsTable.userId as any, clerkUserId));
    await db.update(recommenderQueriesTable)
      .set({ userId: sql`${supabaseUserId}::uuid` })
      .where(eq(recommenderQueriesTable.userId as any, clerkUserId));
    await db.update(facilityLogsTable)
      .set({ userId: sql`${supabaseUserId}::uuid` })
      .where(eq(facilityLogsTable.userId as any, clerkUserId));
  }

  console.log(`✓ backfilled ${mapping.length} user mappings across 4 tables`);
}

main();
