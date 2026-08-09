/**
 * Self-test for mailosaur-otp.mjs OTP extraction.
 *
 * PURE SYNTHETIC FIXTURES ONLY — no real Mailosaur messages. Every input below
 * is a hand-written object mimicking the *shape* of a Mailosaur GET
 * /api/messages/{id} response for a Supabase signup-confirmation email. They
 * assert extraction logic only, nothing about real inboxes.
 *
 * Regression context: the deploy-staging private-media probe intermittently
 * failed at `verifyOtp` ("Token has expired or is invalid") after TEN-012 wired
 * Supabase Auth email through Resend. Resend rewrites links for click-tracking
 * and adds tracking URLs whose numeric ids Mailosaur auto-detects as `codes`.
 * The old extractor trusted the first 6-digit entry in `codes[]`, so it
 * returned a tracking id instead of the real `{{ .Token }}`. These tests pin
 * the hardened behaviour: a digit-run that appears inside a URL is never the
 * OTP, and the labelled plain-text token wins over auto-detected noise.
 *
 * Run:  node --test scripts/ci/lib/mailosaur-otp.self-test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOtp, extractOtpFromMessage } from "./mailosaur-otp.mjs";

// ── extractOtp (single body string) ─────────────────────────────────────────

test("extractOtp: labelled 6-digit code", () => {
  assert.equal(extractOtp("Here's your token [930619]"), "930619");
  assert.equal(extractOtp("Your verification code is 445588."), "445588");
});

test("extractOtp: styled per-digit cells collapse to the code", () => {
  const html = "<td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td>";
  assert.equal(extractOtp(html), "123456");
});

test("extractOtp: digits inside a URL are NOT returned as the OTP", () => {
  // A Resend click-tracking URL with a 6-digit tracking id and NO real code.
  const body = "Confirm here: https://click.resend.com/CL0/aHR0/1/654321/abcd";
  assert.equal(extractOtp(body), null);
});

test("extractOtp: real labelled code wins over a URL digit-run", () => {
  const body =
    "Enter code 930619 to confirm. " +
    "Or visit https://track.resend.com/ss/c/xyz/654321/report";
  assert.equal(extractOtp(body), "930619");
});

// ── extractOtpFromMessage (full Mailosaur message) ──────────────────────────

test("message: bare-token link href still works", () => {
  const full = {
    html: { links: [{ href: "930619", text: "Here's your token" }] },
    text: { body: "Here's your token [930619]" },
  };
  assert.equal(extractOtpFromMessage(full), "930619");
});

test("message: Mailosaur codes[] tracking-id misfire is rejected (REGRESSION)", () => {
  // Mailosaur auto-detected a 6-digit tracking id from a Resend URL as a
  // "code". The real token only appears in the plain-text body. The old
  // extractor returned 654321 (the misfire) → verifyOtp rejected it.
  const full = {
    text: {
      body: "Here's your token [930619]",
      codes: [{ value: "654321" }],
    },
    html: {
      body: '<a href="https://click.resend.com/CL0/aHR0cHM/1/654321/xyz">Confirm</a>',
      codes: [{ value: "654321" }],
      links: [
        {
          href: "https://click.resend.com/CL0/aHR0cHM/1/654321/xyz",
          text: "Confirm",
        },
      ],
    },
  };
  assert.equal(extractOtpFromMessage(full), "930619");
});

test("message: Resend-wrapped href (no bare-token link) falls back to plain-text token", () => {
  const full = {
    text: { body: "Your confirmation code: 771122" },
    html: {
      body: '<a href="https://track.resend.com/ss/c/abc/998877/def">Confirm your email</a>',
      links: [
        {
          href: "https://track.resend.com/ss/c/abc/998877/def",
          text: "Confirm your email",
        },
      ],
    },
  };
  assert.equal(extractOtpFromMessage(full), "771122");
});

test("message: genuine codes[] entry is used when it is not a URL substring", () => {
  const full = {
    text: { body: "Use the code below.", codes: [{ value: "246810" }] },
    html: { body: "<p>Use the code below.</p>" },
  };
  assert.equal(extractOtpFromMessage(full), "246810");
});

test("message: 127.0.0.1 redirect never masquerades as the code", () => {
  const full = {
    text: { body: "Here's your token [503817]" },
    html: {
      body: '<a href="http://127.0.0.1:3000/auth/confirm?token_hash=pkce_9c1a">Confirm</a>',
      links: [
        {
          href: "http://127.0.0.1:3000/auth/confirm?token_hash=pkce_9c1a",
          text: "Confirm",
        },
      ],
    },
  };
  assert.equal(extractOtpFromMessage(full), "503817");
});
