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
import { logger } from "./logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_AGE_DAYS = 7;
const PURGE_AGE_DAYS = 10;
const PAGE_SIZE = 1000;

/**
 * Scan every unverified Supabase auth user and, based on account age:
 *  - age >= 10d: purge. Find the user's OWNER org; if that org has ZERO
 *    facilities, delete the empty org row FIRST, then write audit `purged`,
 *    then delete the auth user (public.users -> organization_members cascade
 *    via on-delete-cascade). Org-before-audit so a failing org delete aborts
 *    before any audit row is written — the next run retries cleanly instead of
 *    stranding a false `purged` row (and a duplicate on the retry). Audit still
 *    precedes the irreversible auth-user delete. If the org HAS >=1 facility,
 *    skip entirely — real data is never auto-deleted. If there is no owner org,
 *    still delete the auth user (audit `purged`); there is nothing else to
 *    clean. A user with no email is still purged (only warning needs an
 *    address), so a no-email account is never stranded forever.
 *  - age >= 7d (and < 10d): warn once. Requires an email address (skipped
 *    otherwise). If no prior `warned` audit row exists for this user, send the
 *    purge-warning email then write audit `warned`. Never warns twice.
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
  const log = opts.log ?? logger;

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
      // Per-user isolation: a throw anywhere below (a bad DB row, a flaky
      // admin/email call) is logged and skipped so it can't halt the sweep —
      // the same failing user must not block every user after it, every run.
      // A user that throws counts as neither warned nor purged.
      try {
        // Verified accounts are spared regardless of age.
        if (user.email_confirmed_at) continue;

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

            // Delete the empty owner org FIRST: if it throws (e.g. a RESTRICT
            // FK still referencing it), no audit row is written, so the next
            // run retries cleanly instead of stranding a false `purged` row and
            // duplicating it on retry. The org is a data-less auto-provisioned
            // shell (zero facilities, asserted above), so deleting it is
            // low-stakes; the audit still precedes the irreversible auth delete.
            await db.delete(organizationsTable).where(eq(organizationsTable.id, membership.organizationId));
            // Audit BEFORE the irreversible auth-user delete.
            await db
              .insert(accountPurgeAuditTable)
              .values({ userId: user.id, email: user.email ?? "", action: "purged" });
            await admin.auth.admin.deleteUser(user.id);
          } else {
            // No owner org — nothing else to clean, still remove the auth user.
            // Audit BEFORE the irreversible auth-user delete.
            await db
              .insert(accountPurgeAuditTable)
              .values({ userId: user.id, email: user.email ?? "", action: "purged" });
            await admin.auth.admin.deleteUser(user.id);
          }

          purged += 1;
        } else if (ageDays >= WARN_AGE_DAYS) {
          // A warning needs somewhere to send to; a no-email account in this
          // window is simply left until it crosses the purge threshold.
          if (!user.email) continue;
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
      } catch (err) {
        // One user's failure is logged and skipped; the sweep continues.
        log?.error(
          { err, userId: user.id },
          "unverified purge: skipping user after error",
        );
        continue;
      }
    }

    if (users.length < PAGE_SIZE) break;
  }

  log?.info({ warned, purged }, "unverified purge complete");
  return { warned, purged };
}
