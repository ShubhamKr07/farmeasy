/**
 * Staging-verification script for the hosted Supabase project.
 *
 * Exercises the end-to-end auth + custom-claim pipeline against a real
 * (non-local) Supabase project, then tears down everything it created:
 *
 *   1. Sign up a throwaway user with the anon-key client.
 *   2. Retrieve + redeem a confirmation OTP via Mailosaur (email confirmation
 *      is enabled; see pollInboxForOtp for tuning via env vars).
 *   3. Seed an organization and active membership via the service-role client.
 *      The custom_access_token_hook (TEN-010) derives the user_role claim from
 *      organization_members.role (not the deprecated public.users.role), and
 *      omits the claim when there is no active membership (TEN-012).
 *   4. Refresh the session so the hook re-runs against the new membership,
 *      decode the JWT, and assert the `user_role` claim == the membership role.
 *      THIS is the core verification — it proves the hook + migration landed
 *      correctly and that membership roles propagate into the access token.
 *   5. Confirm the `media` storage bucket exists and is public.
 *   6. Confirm RLS blocks anonymous reads of public.users.
 *   7. Clean up (delete membership, org, profile, delete Auth user) in a
 *      finally block.
 *
 * Run (from the monorepo root):
 *
 *   STAGING_SUPABASE_URL=https://<project-ref>.supabase.co \
 *   STAGING_SUPABASE_ANON_KEY=eyJ... \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   STAGING_TEST_EMAIL_DOMAIN=example.com \
 *   STAGING_MAILBOX_API_TOKEN=<token> \
 *   STAGING_TEST_PASSWORD=<password> \
 *   node scripts/ci/verify-staging-supabase.mjs
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
    "  Required: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY",
  );
  process.exit(1);
}

// ── Optional env ────────────────────────────────────────────────────────────
const TEST_EMAIL_DOMAIN = process.env.STAGING_TEST_EMAIL_DOMAIN?.replace(/\s/g, "");
const MAILBOX_API_TOKEN = process.env.STAGING_MAILBOX_API_TOKEN?.replace(/\s/g, "");
const TEST_PASSWORD =
  process.env.STAGING_TEST_PASSWORD ?? // reuse a fixed staging password…
  `Verify-Staging-${Date.now()}!Aa1`; // …or generate one per run

// OTP retrieval is required (email confirmation is enabled).
const missing_otp = [
  ["STAGING_TEST_EMAIL_DOMAIN", TEST_EMAIL_DOMAIN],
  ["STAGING_MAILBOX_API_TOKEN", MAILBOX_API_TOKEN],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing_otp.length > 0) {
  console.error(
    `✗ missing required env var${missing_otp.length > 1 ? "s" : ""} for OTP retrieval: ${missing_otp.join(", ")}`,
  );
  console.error("  (Email confirmation is enabled; OTP retrieval is required.)");
  process.exit(1);
}

// Org membership role asserted in the decoded JWT. owner is a non-default
// membership role (vs. technician), so a passing check proves the hook reads
// organization_members.role end-to-end (TEN-010), not the deprecated
// public.users.role or a stale default.
const EXPECTED_MEMBERSHIP_ROLE = "owner";

// OTP retrieval budget, surfaced only in the local log string below. The actual
// pollInboxForOtp tuning (timeout + interval) now lives self-contained in
// ./lib/mailosaur-otp.mjs (the single source of truth, shared with other probes).
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

// ── Main ────────────────────────────────────────────────────────────────────

const ts = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const email = `verify-staging-supabase-${ts}-${rand}@${TEST_EMAIL_DOMAIN}`;

// The instant before signUp — OTP search uses this as receivedAfter so we
// never pick up a stale email for a recycled address.
const signupStartedIso = new Date(ts).toISOString();

// Track state for cleanup. userId is the Auth user id == public.users.id.
let userId = null;
let profileInserted = false;
let seededOrgId = null;

const checks = []; // { name, ok, detail }

try {
  // 1. Sign up via the anon client (the path a real client takes).
  console.log(`▶ signing up test user: ${email}`);
  const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({
    email,
    password: TEST_PASSWORD,
  });

  if (signUpError) {
    throw new Error(`signUp failed: ${signUpError.message}`);
  }
  if (!signUpData.user?.id) {
    throw new Error("signUp returned no user id");
  }
  userId = signUpData.user.id;
  console.log(`✓ signed up; user id = ${userId}`);

  // 2. Retrieve + redeem the confirmation OTP.
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
    type: "signup",
  });
  if (verifyError) {
    throw new Error(`verifyOtp failed: ${verifyError.message}`);
  }
  const sessionAfterVerify = (await supabaseAnon.auth.getSession()).data?.session;
  if (!sessionAfterVerify) {
    throw new Error("no active session after verifyOtp");
  }
  console.log("✓ OTP verified; session established");

  // 3. Seed an organization and active membership via the service-role client.
  //    The hook (TEN-010) reads organization_members.role for the user_role
  //    claim. With no membership, the claim is omitted (TEN-012).
  console.log("▶ seeding organization and active membership");
  const { data: orgRows, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .insert({ name: `verify-staging-${ts}-${rand}` })
    .select("id");
  if (orgErr || !orgRows?.[0]?.id) {
    throw new Error(`could not seed organization: ${orgErr?.message ?? "no id returned"}`);
  }
  seededOrgId = orgRows[0].id;

  const { error: memErr } = await supabaseAdmin
    .from("organization_members")
    .insert({
      organization_id: seededOrgId,
      user_id: userId,
      role: EXPECTED_MEMBERSHIP_ROLE,
      status: "active",
    });
  if (memErr) {
    throw new Error(`could not seed membership: ${memErr.message}`);
  }
  console.log(`✓ organization and active '${EXPECTED_MEMBERSHIP_ROLE}' membership seeded`);

  // Also seed a public.users profile (the hook runs on every token refresh but
  // the profile is still a separate entity that trigger 00004 creates at signup).
  // The hook does not read public.users.role (deprecated per TEN-010), but the
  // profile still needs to exist for other routes.
  const { error: profileErr } = await supabaseAdmin
    .from("users")
    .insert({ id: userId, email });
  if (profileErr && !profileErr.message?.includes("duplicate")) {
    throw new Error(`could not seed profile: ${profileErr.message}`);
  }
  profileInserted = true;

  // 4. Refresh the session so the hook re-runs against the seeded membership,
  //    then decode the JWT and assert user_role == the membership role.
  console.log("▶ refreshing session to re-run custom_access_token_hook");
  const { data: refreshData, error: refreshError } =
    await supabaseAnon.auth.refreshSession();

  if (refreshError) {
    throw new Error(`refreshSession failed: ${refreshError.message}`);
  }
  const accessToken = refreshData.session?.access_token;
  if (!accessToken) {
    throw new Error("refreshSession returned no access_token");
  }

  const payload = decodeJwtPayload(accessToken);
  const claimRole = payload.user_role;
  const claimOk = claimRole === EXPECTED_MEMBERSHIP_ROLE;
  checks.push({
    name: `JWT user_role claim == '${EXPECTED_MEMBERSHIP_ROLE}' (hook reads organization_members.role)`,
    ok: claimOk,
    detail:
      claimRole === undefined
        ? `claim 'user_role' is ABSENT (expected '${EXPECTED_MEMBERSHIP_ROLE}'; hook not reading membership)`
        : `expected '${EXPECTED_MEMBERSHIP_ROLE}', got '${claimRole}'`,
  });
  if (claimOk) {
    console.log(`✓ JWT user_role == '${claimRole}' (hook reads organization_members.role end-to-end)`);
  } else {
    console.error(`✗ CORE CHECK FAILED: ${checks[checks.length - 1].detail}`);
  }

  // 5. Confirm the `media` storage bucket exists and is public.
  console.log("▶ checking media storage bucket");
  const { data: buckets, error: bucketsError } =
    await supabaseAdmin.storage.listBuckets();
  if (bucketsError) {
    checks.push({
      name: "media bucket exists & is public",
      ok: false,
      detail: `listBuckets failed: ${bucketsError.message}`,
    });
    console.error(`✗ listBuckets failed: ${bucketsError.message}`);
  } else {
    const media = buckets.find((b) => b.name === "media");
    const bucketOk = !!media && media.public === true;
    checks.push({
      name: "media bucket exists & is public",
      ok: bucketOk,
      detail: media
        ? `public=${media.public}`
        : "no bucket named 'media' (found: " +
          (buckets.map((b) => b.name).join(", ") || "none") +
          ")",
    });
    if (bucketOk) {
      console.log(`✓ media bucket exists and is public`);
    } else {
      console.error(`✗ media bucket missing or not public (${checks[checks.length - 1].detail})`);
    }
  }

  // 6. Confirm RLS policies are live: an anonymous, unauthenticated client
  //    must not be able to read another user's public.users row.
  console.log("▶ checking RLS enforcement on public.users");
  const supabaseAnonUnauthenticated = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: rlsProbeRows, error: rlsProbeError } = await supabaseAnonUnauthenticated
    .from("users")
    .select("id")
    .eq("id", userId);

  if (rlsProbeError) {
    checks.push({
      name: "RLS blocks anonymous reads of public.users",
      ok: false,
      detail: `probe query itself failed: ${rlsProbeError.message}`,
    });
    console.error(`✗ RLS probe query failed: ${rlsProbeError.message}`);
  } else {
    const rlsOk = (rlsProbeRows?.length ?? 0) === 0;
    checks.push({
      name: "RLS blocks anonymous reads of public.users",
      ok: rlsOk,
      detail: rlsOk
        ? "anonymous client got 0 rows, as expected"
        : `anonymous client read ${rlsProbeRows.length} row(s) — RLS is not enforcing`,
    });
    if (rlsOk) {
      console.log("✓ RLS blocks anonymous reads of public.users");
    } else {
      console.error(`✗ RLS NOT enforcing: anon read ${rlsProbeRows.length} row(s)`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log("──── verification summary ────");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }

  if (failed.length > 0) {
    console.error(
      `\n✗ FAIL: ${failed.length} check(s) failed: ${failed
        .map((c) => c.name)
        .join("; ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ PASS: all checks passed for ${email}`);
  }
} catch (err) {
  console.error(`\n✗ FAIL: aborted at an earlier step — ${err?.message ?? err}`);
  if (err?.stack && process.env.DEBUG) {
    console.error(err.stack);
  }
  console.error("");
  console.error("──── verification summary ────");
  console.error(`✗ aborted before all checks ran: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  // ── Cleanup (always best-effort) ─────────────────────────────────────────
  // Delete in order: membership, org, profile, auth user. The membership's
  // FK cascades (organization_id -> organizations.id), and the organization's
  // FK cascades (user_id -> auth.users.id via public.users), so the cascades
  // could handle it, but we remove explicitly to avoid relying on cascade
  // assumptions and to leave no orphans on a partial failure.

  if (seededOrgId) {
    const { error: delMemErr } = await supabaseAdmin
      .from("organization_members")
      .delete()
      .eq("organization_id", seededOrgId);
    if (delMemErr) {
      console.error(`⚠ cleanup: failed to delete membership: ${delMemErr.message}`);
    } else {
      console.log(`✓ cleanup: deleted membership`);
    }

    const { error: delOrgErr } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", seededOrgId);
    if (delOrgErr) {
      console.error(`⚠ cleanup: failed to delete organization: ${delOrgErr.message}`);
    } else {
      console.log(`✓ cleanup: deleted organization`);
    }
  }

  if (userId) {
    if (profileInserted) {
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
