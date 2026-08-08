// TEN-012 Task 7: fan the waitlist-invite out to every access_requests row
// that has not been notified yet, stamping notified_at as it goes.
//
// NOT wired to any trigger/route/interval in TEN-012 — TEN-011 fires it
// later. The function is idempotent: each row is filtered out once its
// notified_at is non-null, so a second call back-to-back finds nothing and
// sends zero emails.

import { eq, isNull } from "drizzle-orm";
import { db, accessRequestsTable } from "@workspace/db";
import { sendWaitlistInvite } from "./email/index.js";

/**
 * Sends a waitlist-invite to every `access_requests` row whose `notified_at`
 * is still NULL, then stamps `notified_at` on each. Returns `{ sent }` — the
 * number of invites sent this run. Safe to call repeatedly: rows already
 * notified are skipped on subsequent runs, so this degrades to a no-op once
 * the backlog is cleared.
 */
export async function notifyWaitlist(): Promise<{ sent: number }> {
  const rows = await db
    .select({ id: accessRequestsTable.id, email: accessRequestsTable.email })
    .from(accessRequestsTable)
    .where(isNull(accessRequestsTable.notifiedAt));

  for (const row of rows) {
    await sendWaitlistInvite({ to: row.email });
    await db
      .update(accessRequestsTable)
      .set({ notifiedAt: new Date() })
      .where(eq(accessRequestsTable.id, row.id));
  }

  return { sent: rows.length };
}
