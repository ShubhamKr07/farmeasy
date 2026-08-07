// Unverified-account purge job (TEN-012 Task 8).
//
// Accounts that sign up but never confirm their email are cleaned up on a
// slow, auditable cadence: a warning email at day 7, deletion (the Supabase
// auth user + the org that was auto-provisioned for them at wizard bootstrap)
// at day 10. Every action is written to `account_purge_audit` BEFORE the
// irreversible delete, so an audit row always survives even if a later delete
// throws mid-run.
//
// Runs as a named in-process daily job, gated OFF by default — the
// `PURGE_UNVERIFIED_ENABLED` env gate lives at the call site (index.ts), NOT
// in this function (tests call it directly). Mirrors the overdue-scanner
// module shape (a plain async function invoked on boot + setInterval).
//
// Verification lives on the admin user object's `email_confirmed_at`, NOT the
// JWT (confirmed empirically in Task 6 / requireVerifiedEmail). A user is
// unverified iff `email_confirmed_at` is null/undefined.
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  organizationMembersTable,
  organizationsTable,
  facilitiesTable,
  accountPurgeAuditTable,
} from "@workspace/db";
import { supabaseAdmin } from "../middlewares/supabaseAuth.js";
import { sendPurgeWarning } from "./email/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_AGE_DAYS = 7;
const PURGE_AGE_DAYS = 10;
const PAGE_SIZE = 1000;

/**
 * Scan every unverified Supabase auth user and, based on account age:
 *  - age >= 10d: purge. Find the user's OWNER org; if that org has ZERO
 *    facilities, write audit `purged` FIRST, then delete the auth user
 *    (public.users -> organization_members cascade via on-delete-cascade) and
 *    delete the org row. If the org HAS >=1 facility, skip entirely — real
 *    data is never auto-deleted. If there is no owner org, still delete the
 *    auth user (audit `purged`); there is nothing else to clean.
 *  - age >= 7d (and < 10d): warn once. If no prior `warned` audit row exists
 *    for this user, send the purge-warning email then write audit `warned`.
 *    Never warns twice.
 *  - else: skip.
 *
 * Dependencies are injectable (with real defaults) for testability: `now` to
 * simulate account age, `admin` for the Supabase admin client, `sendWarning`
 * for the email sender.
 */
export async function purgeUnverifiedAccounts(
  opts: {
    now?: Date;
    admin?: typeof supabaseAdmin;
    sendWarning?: (p: { to: string }) => Promise<void>;
    log?: Logger;
  } = {},
): Promise<{ warned: number; purged: number }> {
  const now = opts.now ?? new Date();
  const admin = opts.admin ?? supabaseAdmin;
  const sendWarning = opts.sendWarning ?? sendPurgeWarning;
  const log = opts.log;

  let warned = 0;
  let purged = 0;

  // Page through every auth user. GoTrue's listUsers is 1-indexed; stop when a
  // page comes back short (or empty).
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw error;
    const users = data?.users ?? [];
    if (users.length === 0) break;

    for (const user of users) {
      // Verified accounts are spared regardless of age.
      if (user.email_confirmed_at) continue;
      // Without an email there is nothing to warn and no audit key worth
      // keying on — leave it untouched.
      if (!user.email) continue;

      const ageDays = (now.getTime() - new Date(user.created_at).getTime()) / DAY_MS;

      if (ageDays >= PURGE_AGE_DAYS) {
        const [membership] = await db
          .select({ organizationId: organizationMembersTable.organizationId })
          .from(organizationMembersTable)
          .where(
            and(
              eq(organizationMembersTable.userId, user.id),
              eq(organizationMembersTable.role, "owner"),
              eq(organizationMembersTable.status, "active"),
            ),
          )
          .limit(1);

        if (membership) {
          const [facilityCount] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(facilitiesTable)
            .where(eq(facilitiesTable.organizationId, membership.organizationId));

          if ((facilityCount?.n ?? 0) > 0) {
            // Real data present — never auto-delete. Skip without touching a
            // thing (no audit row, no delete).
            log?.info(
              { userId: user.id, organizationId: membership.organizationId },
              "unverified purge skipped: owner org has facilities",
            );
            continue;
          }

          // Audit BEFORE the irreversible delete.
          await db
            .insert(accountPurgeAuditTable)
            .values({ userId: user.id, email: user.email, action: "purged" });
          await admin.auth.admin.deleteUser(user.id);
          // Deleting the auth user cascades to public.users ->
          // organization_members; deleting the org row is belt-and-braces and
          // removes the now-empty owner org itself.
          await db.delete(organizationsTable).where(eq(organizationsTable.id, membership.organizationId));
        } else {
          // No owner org — nothing else to clean, still remove the auth user.
          await db
            .insert(accountPurgeAuditTable)
            .values({ userId: user.id, email: user.email, action: "purged" });
          await admin.auth.admin.deleteUser(user.id);
        }

        purged += 1;
      } else if (ageDays >= WARN_AGE_DAYS) {
        const [prior] = await db
          .select({ id: accountPurgeAuditTable.id })
          .from(accountPurgeAuditTable)
          .where(
            and(
              eq(accountPurgeAuditTable.userId, user.id),
              eq(accountPurgeAuditTable.action, "warned"),
            ),
          )
          .limit(1);
        if (prior) continue; // never warn twice

        await sendWarning({ to: user.email });
        await db
          .insert(accountPurgeAuditTable)
          .values({ userId: user.id, email: user.email, action: "warned" });
        warned += 1;
      }
      // else: younger than the warn threshold — skip.
    }

    if (users.length < PAGE_SIZE) break;
  }

  log?.info({ warned, purged }, "unverified purge complete");
  return { warned, purged };
}
