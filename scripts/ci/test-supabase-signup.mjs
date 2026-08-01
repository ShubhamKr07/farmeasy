/**
 * Hosted-Auth signup integration test for the Release 1 auth pipeline.
 *
 * Replaces the obsolete Clerk/Replit Playwright suite (tests/) with an
 * automated, non-hardware exercise of the real hosted Supabase Auth + profile
 * trigger + custom-claim pipeline. The only FarmEasy auth behavior that
 * *requires* a physical device is the native UI itself — that is recorded as a
 * manual smoke exception; everything else is automated here.
 *
 * What it proves end-to-end against staging:
 *
 *   1. A fresh identity signs up through the staging *anon* client exactly the
 *      way the app does (`auth.signUp`), passing a hostile `role` in signup
 *      metadata to prove the client cannot escalate.
 *   2. The signup confirmation OTP is delivered to a test mailbox and redeemed
 *      via `auth.verifyOtp`, establishing a real session.
 *   3. Task 1's `on_auth_user_created` trigger provisioned exactly ONE
 *      `public.users` profile for the new identity, with role `technician` —
 *      regardless of the `facility_lead` value the client tried to inject.
 *   4. An authenticated client cannot select a role by writing
 *      `public.users` (the profile table has no client UPDATE grant).
 *   5. After refreshing claims, the custom `user_role` JWT claim (read via the
 *      supported `auth.getClaims()` API, not an `as any` session cast) is
 *      `technician`.
 *   6. Signing out and back in with the password still yields `technician`.
 *   7. The identity + profile are deleted in a `finally` block, leaving staging
 *      clean (FK `public.users(id) -> auth.users(id) ON DELETE CASCADE` means
 *      deleting the Auth user would cascade, but both are removed explicitly).
 *
 * Run (from the monorepo root):
 *
 *   STAGING_SUPABASE_URL="$STAGING_SUPABASE_URL" \
 *   STAGING_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY="$STAGING_SUPABASE_SERVICE_ROLE_KEY" \
 *   STAGING_TEST_EMAIL_DOMAIN="$STAGING_TEST_EMAIL_DOMAIN" \
 *   STAGING_MAILBOX_API_TOKEN="$STAGING_MAILBOX_API_TOKEN" \
 *   STAGING_TEST_PASSWORD="$STAGING_TEST_PASSWORD" \
 *   node scripts/ci/test-supabase-signup.mjs
 *
 * Provider assumption (validate when the mailbox account is provisioned):
 *   `STAGING_MAILBOX_API_TOKEN` is a Mailosaur API key and
 *   `STAGING_TEST_EMAIL_DOMAIN` is a Mailosaur-verified custom domain whose MX
 *   records forward inbound mail into the Mailosaur account. Mailosaur is the
 *   canonical OTP-retrieval provider (foundation runbook lists the
 *   "Mailtrap/Mailosaur-style" test inbox as the open item). The provider-
 *   specific code is isolated in `pollInboxForOtp()` / `resolveMailosaurServerId()`
 *   so swapping to a different provider is a localized change. See "Deviations"
 *   in .superpowers/sdd/task-2-report.md.
 *
 * DO NOT point this at production — it creates and deletes real Auth users.
 */
import { createClient } from "@supabase/supabase-js";

// ── Required env ────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.STAGING_SUPABASE_URL?.replace(/\s/g, "");
const SUPABASE_ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY?.replace(/\s/g, "");
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.replace(/\s/g, "");

// (Whitespace strip mirrors api-server/src/middlewares/supabaseAuth.ts — Render
// pastes env vars line-wrapped, embedding a literal newline that breaks the
// apikey/Authorization header. Neither a URL nor a JWT contains whitespace.)

const missing = [
  ["STAGING_SUPABASE_URL", SUPABASE_URL],
  ["STAGING_SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
  ["STAGING_SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(
    `✗ missing required env var${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
  );
  console.error(
    "  Required: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,",
  );
  console.error("           STAGING_SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── Optional-with-default env ───────────────────────────────────────────────
// Domain + mailbox token gate the OTP path. The password never gets a
// *committed* default — only a per-process generated one — so no shared secret
// is ever baked into the repo (the lesson from the deleted Clerk credential).
const TEST_EMAIL_DOMAIN = process.env.STAGING_TEST_EMAIL_DOMAIN?.replace(/\s/g, "");
const MAILBOX_API_TOKEN = process.env.STAGING_MAILBOX_API_TOKEN?.replace(/\s/g, "");
const TEST_PASSWORD =
  process.env.STAGING_TEST_PASSWORD ??
  `Signup-Staging-${Date.now()}-${Math.random().toString(36).slice(2, 10)}!Aa1`;

if (!TEST_EMAIL_DOMAIN || !MAILBOX_API_TOKEN) {
  const need = [
    ["STAGING_TEST_EMAIL_DOMAIN", TEST_EMAIL_DOMAIN],
    ["STAGING_MAILBOX_API_TOKEN", MAILBOX_API_TOKEN],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  console.error(
    `✗ missing required env var${need.length > 1 ? "s" : ""} for the OTP path: ${need.join(", ")}`,
  );
  console.error("  (STAGING_TEST_EMAIL_DOMAIN routes the signup email; STAGING_MAILBOX_API_TOKEN");
  console.error("   is the test-inbox provider key used to retrieve the confirmation OTP.)");
  process.exit(1);
}

// Role the client attempts to inject and which must NOT take effect. facility_lead
// is non-default, so observing 'technician' proves the trigger ignored metadata.
const INJECTED_ROLE = "facility_lead";
const EXPECTED_ROLE = "technician";

// OTP retrieval tuning (operational, not secrets).
const OTP_TIMEOUT_MS = Number(process.env.STAGING_OTP_TIMEOUT_MS ?? 90_000);
const OTP_INTERVAL_MS = Number(process.env.STAGING_OTP_INTERVAL_MS ?? 3_000);

// ── Clients ─────────────────────────────────────────────────────────────────
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode a JWT payload (no signature verification) as a plain object. */
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(`malformed JWT: expected 3 segments, got ${parts.length}`);
  }
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

/**
 * Resolve the Mailosaur server id for the account behind the API key.
 *
 * Mailosaur keys are account-scoped (not server-scoped), so a given key may see
 * multiple servers. We take the first; if the account has more than one, the
 * orchestrator can constrain it to a single server, or this resolution can be
 * extended to filter by name. Localized here so a provider swap touches one fn.
 *
 * @returns {Promise<string>}
 */
async function resolveMailosaurServerId(token) {
  const auth = "Basic " + Buffer.from(`${token}:`).toString("base64");
  const res = await fetch("https://mailosaur.com/api/servers", {
    headers: { Authorization: auth },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Mailosaur GET /api/servers failed: HTTP ${res.status} ${body}`,
    );
  }
  const json = await res.json();
  const items = json.items ?? json.data ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      "Mailosaur account has no servers; create one and verify the test domain.",
    );
  }
  return String(items[0].id);
}

/** Extract a 6-digit confirmation code from an email body. */
function extractOtp(body) {
  if (!body) return null;
  const text = String(body);
  // Prefer a code introduced by a label Supabase's template uses.
  const labeled = text.match(/(?:code|otp|verification|token)[^\d]{0,20}(\d{6})/i);
  if (labeled) return labeled[1];
  // Fallback: the first standalone 6-digit run.
  const plain = text.match(/\b(\d{6})\b/);
  return plain ? plain[1] : null;
}

/**
 * Poll the test mailbox until a confirmation email for `toEmail` arrives after
 * `sinceIso`, then return the 6-digit OTP from its body.
 *
 * @param {{ token: string, toEmail: string, sinceIso: string }} args
 * @returns {Promise<string>}
 */
async function pollInboxForOtp({ token, toEmail, sinceIso }) {
  const serverId = await resolveMailosaurServerId(token);
  const auth = "Basic " + Buffer.from(`${token}:`).toString("base64");
  const url = new URL("https://mailosaur.com/api/messages");
  url.searchParams.set("server", serverId);
  url.searchParams.set("sentTo", toEmail);
  url.searchParams.set("receivedAfter", sinceIso);
  url.searchParams.set("limit", "10");

  const deadline = Date.now() + OTP_TIMEOUT_MS;
  let lastSeen = 0;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Mailosaur GET /api/messages failed: HTTP ${res.status} ${body}`,
      );
    }
    const json = await res.json();
    const items = json.items ?? json.data ?? [];
    lastSeen = items.length;
    for (const msg of items) {
      const body = msg.html ?? msg.text?.body ?? msg.text ?? msg.subject ?? "";
      const otp = extractOtp(body);
      if (otp) return otp;
    }
    await sleep(OTP_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${OTP_TIMEOUT_MS}ms waiting for OTP email to ${toEmail} ` +
      `(last inbox poll saw ${lastSeen} matching message(s)).`,
  );
}

/**
 * Assert the custom `user_role` claim on the anon client's current session is
 * the expected role, read through the supported `getClaims()` API. Optionally
 * refresh the session first so a freshly-minted token re-runs the access-token
 * hook against the trigger-created profile.
 */
async function assertClaimRole({ label, refresh }) {
  if (refresh) {
    const { error: refreshError } = await supabaseAnon.auth.refreshSession();
    if (refreshError) {
      throw new Error(`refreshSession failed during "${label}": ${refreshError.message}`);
    }
  }
  const { data, error } = await supabaseAnon.auth.getClaims();
  if (error) {
    throw new Error(`getClaims() failed during "${label}": ${error.message}`);
  }
  const claimRole = data?.claims?.user_role;
  const ok = claimRole === EXPECTED_ROLE;
  // Diagnostic dump (off unless DEBUG): show the decoded JWT payload.
  if (!ok && process.env.DEBUG) {
    const { data: sess } = await supabaseAnon.auth.getSession();
    if (sess?.session?.access_token) {
      try {
        console.error("DEBUG decoded access_token:", JSON.stringify(decodeJwtPayload(sess.session.access_token)));
      } catch {
        /* ignore decode failure */
      }
    }
  }
  return {
    name: label,
    ok,
    detail:
      claimRole === undefined
        ? "claim 'user_role' is ABSENT (access-token hook not firing / not registered)"
        : `expected '${EXPECTED_ROLE}', got '${claimRole}'`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

const ts = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const email = `signup-${ts}-${rand}@${TEST_EMAIL_DOMAIN}`;

// The instant before signUp — mailbox searches use this as receivedAfter so we
// never pick up a stale email for a recycled address.
const signupStartedIso = new Date(ts).toISOString();

let userId = null; // auth.users id == public.users id
let profileCreated = false; // tracked so finally knows whether to attempt profile delete
const checks = [];

try {
  // 1. Sign up via the anon client — the real client path — with a hostile
  //    `role` in metadata to prove the client cannot escalate.
  console.log(`▶ signing up test user: ${email} (metadata.role = '${INJECTED_ROLE}')`);
  const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({
    email,
    password: TEST_PASSWORD,
    options: { data: { role: INJECTED_ROLE } },
  });
  if (signUpError) throw new Error(`signUp failed: ${signUpError.message}`);
  if (!signUpData.user?.id) {
    throw new Error("signUp returned no user id (identity not created)");
  }
  userId = signUpData.user.id;
  console.log(`✓ signed up; user id = ${userId}`);

  // 2. Retrieve + redeem the confirmation OTP. With email confirmation enabled
  //    (the foundation-plan target state) signUp returns no usable session; the
  //    session is established only after verifyOtp. If confirmation is still
  //    disabled on staging, signUp already returned a session and verifyOtp
  //    may report "already confirmed" — tolerate that so the script degrades
  //    gracefully instead of hard-failing an otherwise-valid run.
  console.log(`▶ retrieving confirmation OTP from mailbox (${OTP_TIMEOUT_MS}ms budget)`);
  const otp = await pollInboxForOtp({
    token: MAILBOX_API_TOKEN,
    toEmail: email,
    sinceIso: signupStartedIso,
  });
  console.log(`✓ OTP retrieved from mailbox`);

  console.log("▶ redeeming OTP via auth.verifyOtp");
  const { error: verifyError } = await supabaseAnon.auth.verifyOtp({
    email,
    token: otp,
    type: "email",
  });
  const sessionAfterVerify = (await supabaseAnon.auth.getSession()).data?.session;
  if (verifyError) {
    const msg = String(verifyError.message ?? "").toLowerCase();
    const tolerable =
      !!sessionAfterVerify &&
      (msg.includes("already confirmed") ||
        msg.includes("already") ||
        msg.includes("session"));
    if (tolerable) {
      console.log(
        `⚠ verifyOtp returned "${verifyError.message}" but an active session exists (confirmation likely disabled) — proceeding.`,
      );
    } else {
      throw new Error(`verifyOtp failed: ${verifyError.message}`);
    }
  } else {
    console.log("✓ OTP verified; session established");
  }
  if (!sessionAfterVerify) {
    throw new Error("no active session after verifyOtp — cannot read claims");
  }

  // 3. Assert exactly ONE trigger-created profile with role technician.
  console.log("▶ checking trigger-created profile via service-role client");
  const { data: profileRows, error: profileError } = await supabaseAdmin
    .from("users")
    .select("id, email, role")
    .eq("id", userId);
  if (profileError) {
    throw new Error(`profile lookup failed: ${profileError.message}`);
  }
  const count = profileRows?.length ?? 0;
  profileCreated = count > 0;
  const exactlyOne = count === 1;
  checks.push({
    name: "exactly one trigger-created profile exists",
    ok: exactlyOne,
    detail: `found ${count} public.users row(s) for id=${userId}`,
  });
  if (!exactlyOne) {
    console.error(`✗ expected exactly 1 profile, found ${count}`);
  } else {
    const row = profileRows[0];
    const roleOk = row.role === EXPECTED_ROLE;
    checks.push({
      name: `profile role is '${EXPECTED_ROLE}' (trigger ignored client metadata)`,
      ok: roleOk,
      detail: `role='${row.role}' (client tried to inject '${INJECTED_ROLE}'), email='${row.email}'`,
    });
    if (!roleOk) {
      console.error(
        `✗ role escalation: profile role='${row.role}', expected '${EXPECTED_ROLE}' — client metadata was honored!`,
      );
    } else {
      console.log(`✓ profile role='${row.role}' (client 'facility_lead' metadata ignored)`);
    }
  }

  // 4. Assert an authenticated client cannot SELECT/escalate a role by writing
  //    the profile row — public.users has no client UPDATE grant, so an update
  //    through the anon (authenticated) client must be rejected. (We have a
  //    real session on the anon client now.)
  console.log("▶ checking client cannot write role via authenticated session");
  const { error: writeError } = await supabaseAnon
    .from("users")
    .update({ role: INJECTED_ROLE })
    .eq("id", userId);
  const writeBlocked = !!writeError;
  checks.push({
    name: "authenticated client cannot update profile role",
    ok: writeBlocked,
    detail: writeError
      ? `denied as expected (${writeError.code ?? writeError.message})`
      : "update was NOT denied — client can mutate role!",
  });
  if (writeBlocked) {
    console.log(`✓ client role update denied (${writeError.code ?? writeError.message})`);
  } else {
    console.error("✗ client was able to update profile role (RLS/grant hole)");
  }

  // 5. Refresh claims then read user_role via getClaims().
  console.log("▶ refreshing session and reading user_role claim via getClaims()");
  checks.push(await assertClaimRole({ label: "user_role claim == technician (post-refresh)", refresh: true }));

  // 6. Sign out / sign back in and re-assert the claim on a fresh session.
  console.log("▶ signing out, then signing back in with password");
  const { error: signOutError } = await supabaseAnon.auth.signOut();
  if (signOutError) {
    // Non-fatal: the subsequent signInWithPassword establishes a fresh session.
    console.log(`⚠ signOut returned: ${signOutError.message}`);
  }
  const { data: signInData, error: signInError } =
    await supabaseAnon.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signInError) throw new Error(`signInWithPassword failed: ${signInError.message}`);
  if (!signInData.session) throw new Error("signInWithPassword returned no session");
  console.log("✓ signed back in");
  checks.push(await assertClaimRole({ label: "user_role claim == technician (post sign-out/in)", refresh: false }));

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log("──── signup verification summary ────");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }

  if (failed.length > 0) {
    console.error(
      `\n✗ FAIL: ${failed.length} check(s) failed: ${failed.map((c) => c.name).join("; ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ PASS: hosted Auth signup pipeline verified for ${email}`);
  }
} catch (err) {
  console.error(`\n✗ FAIL: aborted at an earlier step — ${err?.message ?? err}`);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  console.error("");
  console.error("──── signup verification summary ────");
  console.error(`✗ aborted before all checks ran: ${err?.message ?? err}`);
  for (const c of checks) {
    console.error(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  process.exitCode = 1;
} finally {
  // ── Cleanup (always best-effort) ─────────────────────────────────────────
  // Delete the profile row first (no FK from auth -> profile), then the Auth
  // identity. The ON DELETE CASCADE FK would handle the profile on Auth delete
  // alone, but removing both explicitly guarantees no orphan survives a partial
  // failure and keeps the finally block independent of FK assumptions.
  if (userId) {
    if (profileCreated) {
      const { error: delProfileError } = await supabaseAdmin
        .from("users")
        .delete()
        .eq("id", userId);
      if (delProfileError) {
        console.error(
          `⚠ cleanup: failed to delete public.users row for ${userId}: ${delProfileError.message}`,
        );
      } else {
        console.log(`✓ cleanup: deleted public.users row for ${userId}`);
      }
    }
    const { error: delUserError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delUserError) {
      console.error(
        `⚠ cleanup: failed to delete Auth user ${userId}: ${delUserError.message}`,
      );
    } else {
      console.log(`✓ cleanup: deleted Auth user ${userId}`);
    }
  }
}
