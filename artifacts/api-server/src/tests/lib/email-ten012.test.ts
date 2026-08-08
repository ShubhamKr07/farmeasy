// TEN-012 Task 7: purge-warning + waitlist-invite email senders, and the
// `notifyWaitlist` job that fans the waitlist-invite out to every
// un-notified access_requests row.
//
// The two sender unit tests run against the `record` transport (no network):
// EMAIL_TRANSPORT=record pushes each delivered email into the in-memory sink
// in src/lib/email/transport.ts, which getRecordedEmails() reads back. The
// notifyWaitlist test seeds real access_requests rows over the admin
// connection and asserts the function (a) sends exactly one invite per
// un-notified row, (b) stamps notified_at on each, leaving any pre-notified
// row's timestamp untouched, and (c) is idempotent — a second call finds no
// un-notified rows and sends zero.
import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  sendPurgeWarning,
  sendWaitlistInvite,
  getRecordedEmails,
  resetRecordedEmails,
} from "../../lib/email/index.js";
import {
  useDatabaseFixture,
  getAdminDb,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase.js";

closeDatabasePoolAfterTests();

describe("TEN-012 email senders (record transport)", () => {
  before(() => {
    process.env.EMAIL_TRANSPORT = "record";
  });
  beforeEach(() => {
    resetRecordedEmails();
  });

  test("sendPurgeWarning records exactly one email to the recipient with the expected subject", async () => {
    const to = "unverified@example.com";
    await sendPurgeWarning({ to });

    const emails = getRecordedEmails();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, to);
    assert.equal(emails[0].subject, "Your FarmSmart account will be removed soon");
    // Body should carry a clear verify call-to-action.
    assert.match(emails[0].html, /verif/i);
  });

  test("sendWaitlistInvite records exactly one email to the recipient with the expected subject", async () => {
    const to = "waitlister@example.com";
    await sendWaitlistInvite({ to });

    const emails = getRecordedEmails();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, to);
    assert.equal(emails[0].subject, "You can now create your FarmSmart account");
    // Body should invite them to sign up.
    assert.match(emails[0].html, /sign up|create your account/i);
  });
});

const admin = getAdminDb();

describe("notifyWaitlist", { skip: !admin }, () => {
  useDatabaseFixture(["access_requests"]);

  beforeEach(() => {
    resetRecordedEmails();
  });

  test("sends one invite per un-notified row, stamps notified_at, leaves pre-notified row untouched, and is idempotent", async () => {
    const adminDb = getAdminDb()!;
    const { accessRequestsTable } = await import("@workspace/db");
    const { notifyWaitlist } = await import("../../lib/notifyWaitlist.js");

    const preNotifiedAt = new Date("2024-01-01T00:00:00Z");

    // 2 un-notified + 1 already-notified.
    await adminDb.insert(accessRequestsTable).values([
      { email: "wl1@example.com", farmName: "Farm One" },
      { email: "wl2@example.com", farmName: "Farm Two" },
      { email: "wl3@example.com", farmName: "Farm Three", notifiedAt: preNotifiedAt },
    ]);

    const first = await notifyWaitlist();
    assert.deepEqual(first, { sent: 2 });

    // Exactly two emails recorded — one per un-notified row.
    const emails = getRecordedEmails();
    assert.equal(emails.length, 2);
    assert.deepEqual(
      emails.map((e) => e.to).sort(),
      ["wl1@example.com", "wl2@example.com"],
    );

    // The two notified rows now have a notified_at; the pre-notified row is
    // unchanged.
    const after = await adminDb.select().from(accessRequestsTable);
    const byEmail = new Map(
      after.map((r: { email: string; notifiedAt: Date | null }) => [r.email, r.notifiedAt]),
    );
    assert.ok(byEmail.get("wl1@example.com") != null, "wl1 notified_at should be set");
    assert.ok(byEmail.get("wl2@example.com") != null, "wl2 notified_at should be set");
    assert.deepEqual(
      byEmail.get("wl3@example.com"),
      preNotifiedAt,
      "pre-notified row's notified_at must be unchanged",
    );

    // Second call: nothing left to send.
    resetRecordedEmails();
    const second = await notifyWaitlist();
    assert.deepEqual(second, { sent: 0 });
    assert.equal(getRecordedEmails().length, 0);

    // notified_at of the pre-notified row still unchanged after the no-op call.
    const stillPre = await adminDb
      .select()
      .from(accessRequestsTable)
      .where(eq(accessRequestsTable.email, "wl3@example.com"));
    assert.deepEqual(stillPre[0].notifiedAt, preNotifiedAt);
  });
});
