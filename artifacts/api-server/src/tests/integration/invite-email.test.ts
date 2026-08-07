// artifacts/api-server/src/tests/integration/invite-email.test.ts
//
// Real end-to-end integration test for the team-invite email (TEN-010 Task
// 15): sends a real invite through the app's PRODUCTION transport (Resend,
// `EMAIL_TRANSPORT=resend`) to a Mailosaur receive address, then captures
// and inspects the actual delivered message via the Mailosaur SDK -- proving
// the real send path (not the `record` transport unit tests use) produces a
// well-formed email with a working token link, and checking its spam score.
//
// Required env (all four, or the whole suite skips -- see `canRun` below):
//   - MAILOSAUR_API_KEY    Mailosaur account API key (Mailosaur SDK auth).
//   - MAILOSAUR_SERVER_ID  Mailosaur inbox (server) id; messages are sent to
//                          `<random>@${MAILOSAUR_SERVER_ID}.mailosaur.net`
//                          and captured back from that same server.
//   - RESEND_API_KEY       Resend API key for the real send -- this test
//                          exercises `deliver()`'s "resend" branch
//                          (src/lib/email/transport.ts), not the `record`
//                          in-memory sink every other email test uses.
//   - EMAIL_FROM           A VERIFIED Resend sending domain address. Resend
//                          rejects sends from unverified domains, so this
//                          must be a real, verified "from" address in the
//                          Resend account the RESEND_API_KEY belongs to.
//
// Nothing here is faked: `sendInvite` (src/lib/email/index.ts) is called
// exactly as invitations.ts calls it in production, EMAIL_TRANSPORT is
// forced to "resend" so the real Resend HTTP API is hit, and the assertions
// read the message back from Mailosaur's own capture of what actually
// arrived -- not from the app's own recorded-email sink.
import { after, describe, test } from "node:test";
import { ok, match, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Mailosaur from "mailosaur";
import { sendInvite } from "../../lib/email/index.js";

const mailosaurApiKey = process.env.MAILOSAUR_API_KEY;
const mailosaurServerId = process.env.MAILOSAUR_SERVER_ID;
const resendApiKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.EMAIL_FROM;

const canRun = Boolean(mailosaurApiKey && mailosaurServerId && resendApiKey && emailFrom);

// A spam score above this is treated as a deliverability regression. Mailosaur's
// SpamAssassin-based score is unbounded but low-single-digits is the normal
// range for a plain transactional email; this threshold leaves generous
// headroom while still catching a genuinely broken/spammy template.
const MAX_ACCEPTABLE_SPAM_SCORE = 5;

describe("Team-invite email: real Resend send -> Mailosaur capture (TEN-010 Task 15)", { skip: !canRun }, () => {
  let capturedMessageId: string | undefined;
  let previousTransport: string | undefined;

  after(async () => {
    if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = previousTransport;

    if (capturedMessageId) {
      const mailosaur = new Mailosaur(mailosaurApiKey!);
      await mailosaur.messages.del(capturedMessageId).catch(() => {
        // Best-effort cleanup only -- a failed delete must never fail the suite.
      });
    }
  });

  test("sendInvite delivers a real email via Resend, received by Mailosaur, with the correct subject, token link, and an acceptable spam score", async () => {
    previousTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "resend";

    const knownToken = `invite-e2e-${randomUUID()}`;
    const recipient = `invite-e2e-${randomUUID()}@${mailosaurServerId}.mailosaur.net`;
    const orgName = "Mailosaur E2E Test Farms";
    const inviteUrl = `https://dash.farmsmart.example/accept-invite#token=${knownToken}`;

    await sendInvite({
      to: recipient,
      inviteUrl,
      orgName,
      role: "technician",
    });

    const mailosaur = new Mailosaur(mailosaurApiKey!);
    const message = await mailosaur.messages.get(
      mailosaurServerId!,
      { sentTo: recipient },
      { timeout: 60_000 },
    );

    ok(message.id, "captured message must have an id");
    capturedMessageId = message.id;

    strictEqual(message.subject, `You're invited to ${orgName} on FarmSmart`);

    const htmlBody = message.html?.body ?? "";
    match(
      htmlBody,
      new RegExp(`#token=${knownToken}`),
      `invite email HTML must contain the known token link, got: ${htmlBody}`,
    );

    // Nice-to-have: confirm the real Resend send doesn't read as spammy.
    const spamResult = await mailosaur.analysis.spam(message.id!);
    ok(
      spamResult.score !== undefined && spamResult.score <= MAX_ACCEPTABLE_SPAM_SCORE,
      `invite email spam score ${spamResult.score} exceeds acceptable threshold ${MAX_ACCEPTABLE_SPAM_SCORE}`,
    );
  });
});
