import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sendInvite } from "./index.js";
import { getRecordedEmails, resetRecordedEmails } from "./transport.js";

describe("sendInvite (record transport)", () => {
  beforeEach(() => {
    process.env.EMAIL_TRANSPORT = "record";
    resetRecordedEmails();
  });

  it("records one email with the invite link, recipient, and role", async () => {
    await sendInvite({
      to: "invitee@example.com",
      inviteUrl: "https://dash.example/accept-invite#token=RAWTOKEN",
      orgName: "Acme Farms",
      role: "technician",
    });
    const sent = getRecordedEmails();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, "invitee@example.com");
    assert.match(sent[0].html, /accept-invite#token=RAWTOKEN/);
    assert.match(sent[0].html, /Acme Farms/);
    assert.match(sent[0].subject, /invit/i);
  });
});
