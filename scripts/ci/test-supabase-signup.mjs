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
 *   4. An authenticated client cannot escalate its role by writing
 *      `public.users`: migration 00004 dropped the client UPDATE policy, so
 *      the write is RLS-filtered to zero rows (no error) and the role, re-read
 *      via the service-role client, is unchanged.
 *   5. For this membership-less fresh signup the custom `user_role` JWT claim
 *      (read via the supported `auth.getClaims()` API) is ABSENT — TEN-010's
 *      hook derives it from `organization_members.role` and omits it when
 *      there is no active membership.
 *   6. After seeding an active owner membership and re-authenticating, the
 *      `user_role` claim becomes `owner` — proving the hook reads
 *      `organization_members.role` end-to-end.
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
 *   specific code is isolated in `pollInboxForOtp()` / `serverIdFromEmail()`
 *   so swapping to a different provider is a localized change. See "Deviations"
 *   in .superpowers/sdd/task-2-report.md.
 *
 * DO NOT point this at production — it creates and deletes real Auth users.
 */
import { createClient } from "@supabase/supabase-js";
import { pollInboxForOtp } from "./lib/mailosaur-otp.mjs";

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

// OTP retrieval budget, surfaced only in the local log string below. The actual
// pollInboxForOtp tuning (timeout + interval) now lives self-contained in
// ./lib/mailosaur-otp.mjs (the single source of truth, shared with the probe).
const OTP_TIMEOUT_MS = Number(process.env.STAGING_OTP_TIMEOUT_MS ?? 90_000);

// ── Clients ─────────────────────────────────────────────────────────────────
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

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
 * Assert the custom `user_role` claim on the anon client's current session is
 * the expected role, read through the supported `getClaims()` API. Optionally
 * refresh the session first so a freshly-minted token re-runs the access-token
 * hook against the trigger-created profile.
 */
async function assertClaimRole({ label, refresh, expected }) {
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
  // `expected === undefined` means the claim must be ABSENT — the correct
  // post-TEN-010 state for a user with no active org membership (the hook
  // omits user_role rather than defaulting it).
  const ok = claimRole === expected;
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
  const want = expected === undefined ? "ABSENT (no active membership)" : `'${expected}'`;
  const got = claimRole === undefined ? "ABSENT" : `'${claimRole}'`;
  return { name: label, ok, detail: `expected user_role ${want}, got ${got}` };
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
let seededOrgId = null; // org seeded to prove the membership->claim path; cleaned in finally
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

  // 2. Retrieve + redeem the confirmation OTP — but only when signUp() didn't
  //    already return a live session. Email confirmation is a per-project
  //    Supabase Auth setting; when it's disabled, signUp() returns an
  //    already-confirmed session and no email is EVER sent, so polling an
  //    inbox for an OTP that will never arrive hangs for the full timeout.
  //    Check the immediate signUp() result generically instead of assuming
  //    any one environment's config (staging currently has confirmation
  //    disabled; production's setting must not be assumed to match).
  let sessionAfterVerify = signUpData.session;
  if (sessionAfterVerify) {
    console.log(
      "⚠ signUp() returned an active session immediately — email confirmation is disabled on this project; skipping OTP poll/verify",
    );
  } else {
    console.log(`▶ retrieving confirmation OTP from mailbox (${OTP_TIMEOUT_MS}ms budget)`);
    const otp = await pollInboxForOtp({
      token: MAILBOX_API_TOKEN,
      toEmail: email,
      sinceIso: signupStartedIso,
    });
    console.log(`✓ OTP retrieved from mailbox`);

    console.log("▶ redeeming OTP via auth.verifyOtp");
    // type "signup" — this is a brand-new-account confirmation OTP (the email's
    // own verify URL carries type=signup). "email" is for existing-user email
    // OTP sign-in and would reject a fresh signup token.
    const { error: verifyError } = await supabaseAnon.auth.verifyOtp({
      email,
      token: otp,
      type: "signup",
    });
    sessionAfterVerify = (await supabaseAnon.auth.getSession()).data?.session;
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
  }
  if (!sessionAfterVerify) {
    throw new Error("no active session after signUp/verifyOtp — cannot read claims");
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

  // 4. Assert an authenticated client cannot escalate its role by writing the
  //    profile row. Migration 00004 DROPPED the client UPDATE policy on
  //    public.users (only a backend `current_user='farmsmart_app'` policy
  //    remains, added in 00009), so a client UPDATE matches zero rows under
  //    RLS. IMPORTANT: PostgREST does NOT return an error for an RLS-filtered
  //    UPDATE — it reports success with 0 rows affected. So the block must be
  //    proven by RE-READING the role with the service-role client and
  //    asserting it is unchanged, never by checking for an error (which never
  //    comes and previously produced a false "escalation hole" failure).
  console.log("▶ checking client cannot escalate role via authenticated session");
  const { error: writeError } = await supabaseAnon
    .from("users")
    .update({ role: INJECTED_ROLE })
    .eq("id", userId);
  const { data: afterRows, error: reReadError } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", userId);
  if (reReadError) {
    throw new Error(`could not re-read role to verify escalation block: ${reReadError.message}`);
  }
  const roleAfter = afterRows?.[0]?.role;
  const escalationBlocked = roleAfter === EXPECTED_ROLE;
  checks.push({
    name: "authenticated client cannot escalate profile role",
    ok: escalationBlocked,
    detail: escalationBlocked
      ? `role still '${roleAfter}' after client UPDATE attempt ` +
        (writeError
          ? `(update errored: ${writeError.code ?? writeError.message})`
          : "(update silently filtered to 0 rows under RLS — no error, as expected)")
      : `role is now '${roleAfter}' after a client UPDATE — REAL ESCALATION HOLE (expected still '${EXPECTED_ROLE}')`,
  });
  if (escalationBlocked) {
    console.log(`✓ role unchanged ('${roleAfter}') — client cannot escalate`);
  } else {
    console.error(`✗ role escalated to '${roleAfter}' — RLS/grant hole`);
  }

  // 5. A fresh signup has NO org membership yet — TEN-012 lazy-provisions the
  //    owner org at wizard bootstrap, not at signup. TEN-010's access-token
  //    hook derives user_role from organization_members.role and OMITS the
  //    claim when there is no active membership, so it MUST be absent here. (A
  //    'technician' claim would mean the hook still reads the deprecated
  //    public.users.role path.)
  console.log("▶ refreshing session; user_role claim must be ABSENT (no membership yet)");
  checks.push(await assertClaimRole({
    label: "user_role claim ABSENT for a membership-less fresh signup",
    refresh: true,
    expected: undefined,
  }));

  // 6. Seed an ACTIVE owner membership via the service-role client, then sign
  //    out / back in so a freshly-minted token re-runs the hook. The hook must
  //    now surface user_role = the membership role — proving it reads
  //    organization_members.role end-to-end, not merely that it omits.
  console.log("▶ seeding an owner membership, then re-authenticating to re-run the hook");
  const { data: orgRows, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .insert({ name: `signup-smoke-${ts}-${rand}` })
    .select("id");
  if (orgErr || !orgRows?.[0]?.id) {
    throw new Error(`could not seed org for the claim check: ${orgErr?.message ?? "no id returned"}`);
  }
  seededOrgId = orgRows[0].id;
  const { error: memErr } = await supabaseAdmin
    .from("organization_members")
    .insert({ organization_id: seededOrgId, user_id: userId, role: "owner", status: "active" });
  if (memErr) throw new Error(`could not seed membership for the claim check: ${memErr.message}`);

  const { error: signOutError } = await supabaseAnon.auth.signOut();
  if (signOutError) {
    // Non-fatal: the subsequent signInWithPassword establishes a fresh session.
    console.log(`⚠ signOut returned: ${signOutError.message}`);
  }
  const { data: signInData, error: signInError } =
    await supabaseAnon.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signInError) throw new Error(`signInWithPassword failed: ${signInError.message}`);
  if (!signInData.session) throw new Error("signInWithPassword returned no session");
  console.log("✓ signed back in with an active membership");
  checks.push(await assertClaimRole({
    label: "user_role claim == owner after membership seeded (hook reads organization_members.role)",
    refresh: false,
    expected: "owner",
  }));

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
  // Delete the seeded org first (its FK cascades the seeded membership, whose
  // user_id FK would otherwise be removed by the auth-user cascade anyway —
  // but the org row itself has no such cascade, so remove it explicitly).
  if (seededOrgId) {
    const { error: delOrgErr } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", seededOrgId);
    if (delOrgErr) {
      console.error(`⚠ cleanup: failed to delete seeded org ${seededOrgId}: ${delOrgErr.message}`);
    } else {
      console.log(`✓ cleanup: deleted seeded org ${seededOrgId}`);
    }
  }

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
