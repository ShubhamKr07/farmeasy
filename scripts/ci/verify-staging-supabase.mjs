/**
 * Staging-verification script for the hosted Supabase project.
 *
 * Exercises the end-to-end auth + custom-claim pipeline against a real
 * (non-local) Supabase project, then tears down everything it created:
 *
 *   1. Sign up a throwaway user with the anon-key client.
 *   2. (OTP step is conditional — see below.)
 *   3. Insert a public.users profile row for that user with role='facility_lead'
 *      using the service-role client. Staging has no profile-creation trigger
 *      yet (that's Release 1), so the script owns this step.
 *   4. Refresh the session so the custom_access_token_hook re-runs against the
 *      new row, decode the JWT, and assert the `user_role` claim == 'facility_lead'.
 *      THIS is the core verification — it proves the hook + migration landed
 *      correctly and that non-default roles propagate into the access token.
 *   5. Confirm the `media` storage bucket exists and is public.
 *   6. Confirm 3 Supabase migrations are recorded in
 *      supabase_migrations.schema_migrations.
 *   7. Clean up (delete public.users row, delete Auth user) in a finally block.
 *
 * Run (from the monorepo root):
 *
 *   STAGING_SUPABASE_URL=https://<project-ref>.supabase.co \
 *   STAGING_SUPABASE_ANON_KEY=eyJ... \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/ci/verify-staging-supabase.mjs
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
    "  Required: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY",
  );
  process.exit(1);
}

// ── Optional env ────────────────────────────────────────────────────────────
const TEST_EMAIL_DOMAIN = process.env.STAGING_TEST_EMAIL_DOMAIN; // e.g. "example.com"
const TEST_PASSWORD =
  process.env.STAGING_TEST_PASSWORD ?? // reuse a fixed staging password…
  `Verify-Staging-${Date.now()}!Aa1`; // …or generate one per run
const MAILBOX_API_TOKEN = process.env.STAGING_MAILBOX_API_TOKEN; // set to enable OTP retrieval

// Role asserted on the profile row and in the decoded JWT. facility_lead is a
// non-default user_role value, so a passing check proves the claim path works
// end-to-end (a default 'technician' would pass trivially even if the hook
// never read the row).
const EXPECTED_ROLE = "facility_lead";

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
  // base64url -> base64 -> JSON. atob is global in Node 16+.
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

// ── Main ────────────────────────────────────────────────────────────────────

const ts = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const domain = TEST_EMAIL_DOMAIN || "example.com";
const email = `verify-staging-supabase-${ts}-${rand}@${domain}`;

// Track state for cleanup. userId is the Auth user id == public.users.id.
let userId = null;
let profileInserted = false;

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
    // signUp can return no user (e.g. email confirmation required + opaque
    // response) — without a user id we can't insert a profile or assert a
    // claim, so this is a hard stop, not a soft skip.
    throw new Error("signUp returned no user id");
  }
  userId = signUpData.user.id;
  console.log(`✓ signed up; user id = ${userId}`);

  // 2. OTP / email-confirmation step — CONDITIONAL.
  //
  // Staging has email confirmation disabled, so signUp() already returns a
  // usable session and we can skip OTP entirely. If confirmation is ever
  // re-enabled, STAGING_MAILBOX_API_TOKEN gates the retrieval path.
  if (!MAILBOX_API_TOKEN) {
    console.log(
      "⚠ STAGING_MAILBOX_API_TOKEN not set — OTP retrieval skipped (staging has confirmation disabled; proceeding with the signUp session).",
    );
  } else {
    // TODO(OTP): a real OTP retrieval flow would look like this, but no
    // mailbox/inbox service has been chosen for the project yet, so it is
    // intentionally NOT implemented here. Sketch only:
    //
    //   // 1. Poll the mailbox/inbox API until Supabase's confirmation email
    //   //    arrives (the token is a 6-digit code in the body). Pseudocode:
    //   //    const otp = await pollInboxForOtp({
    //   //      token: MAILBOX_API_TOKEN,
    //   //      to: email,
    //   //      subjectContains: "Confirm",
    //   //      retries: 30, intervalMs: 2000,
    //   //    });
    //   //
    //   //    // 2. Exchange the OTP for a verified session:
    //   //    //    const { error } = await supabaseAnon.auth.verifyOtp({
    //   //    //      email, token: otp, type: "email",
    //   //    //    });
    //   //    //    if (error) throw new Error(`verifyOtp failed: ${error.message}`);
    //   //
    //   // Until a concrete provider is picked, leave OTP unimplemented and
    //   // rely on the confirmation-disabled session above.
    console.log(
      "ℹ STAGING_MAILBOX_API_TOKEN is set, but OTP retrieval is not implemented yet — proceeding with the signUp session (see TODO).",
    );
  }

  // 3. Insert a public.users profile row via the service-role client.
  //    No profile-creation trigger exists on staging yet (Release 1), so the
  //    script owns this insert. facility_lead is deliberately non-default.
  console.log(`▶ inserting public.users row with role='${EXPECTED_ROLE}'`);
  const { error: insertError } = await supabaseAdmin
    .from("users")
    .insert({ id: userId, email, role: EXPECTED_ROLE });

  if (insertError) {
    throw new Error(`profile insert failed: ${insertError.message}`);
  }
  profileInserted = true;
  console.log(`✓ profile inserted`);

  // 4. Refresh the session so the access-token hook re-runs against the new
  //    row, then decode the JWT and assert user_role == facility_lead.
  //
  //    Why refresh: the token minted at signUp() runs BEFORE the profile row
  //    exists, so its user_role would be the hook's default 'technician'.
  //    Refreshing forces a fresh token through the hook with the row present.
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
  const claimOk = claimRole === EXPECTED_ROLE;
  checks.push({
    name: "JWT user_role claim == facility_lead",
    ok: claimOk,
    detail:
      claimRole === undefined
        ? "claim 'user_role' is ABSENT (hook not registered / not firing)"
        : `expected '${EXPECTED_ROLE}', got '${claimRole}'`,
  });
  if (claimOk) {
    console.log(`✓ JWT user_role == '${claimRole}' (expected '${EXPECTED_ROLE}')`);
  } else {
    // Don't throw yet — still run the remaining structural checks so the report
    // is maximally useful, then fail at the summary. This is the core check,
    // so it WILL flip the exit code to 1.
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

  // 6. Confirm 3 migrations are recorded.
  console.log("▶ checking applied migrations");
  const { data: migrations, error: migrationsError } = await supabaseAdmin
    .from("supabase_migrations.schema_migrations")
    .select("version")
    .order("version", { ascending: true });

  if (migrationsError) {
    checks.push({
      name: "3 migrations recorded",
      ok: false,
      detail: `query failed: ${migrationsError.message}`,
    });
    console.error(`✗ migrations query failed: ${migrationsError.message}`);
  } else {
    const count = migrations?.length ?? 0;
    const migOk = count >= 3;
    checks.push({
      name: "3 migrations recorded",
      ok: migOk,
      detail: `found ${count}: ${(migrations || [])
        .map((m) => m.version)
        .join(", ")}`,
    });
    if (migOk) {
      console.log(`✓ ${count} migrations recorded (>= 3)`);
    } else {
      console.error(`✗ expected >=3 migrations, found ${count}`);
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
  // An exception means a step couldn't even run to completion (vs. a check
  // that ran and returned a negative result).
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
  // Order matters: delete the profile row first (its id references the Auth
  // user, but there's no FK from public.users -> auth.users, so order is
  // really about leaving no orphan either way), then delete the Auth user.
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
