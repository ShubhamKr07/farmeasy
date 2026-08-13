/**
 * Demo-fork (TEN-013) staging verification probe.
 *
 * GATES THE PROD FLIP: `DEMO_FORK_ENABLED` is a Render dashboard env var on
 * the api service, read by `artifacts/api-server/src/lib/demoFork.ts` as
 * `(process.env.DEMO_FORK_ENABLED ?? "").toLowerCase() === "true"`. After a
 * human flips it to `true` on staging (this script never touches Render
 * itself), run this probe against the LIVE staging API before flipping
 * production. A failing probe means the flag flip must NOT be promoted.
 *
 * It reuses the EXACT auth harness the rest of the deploy-gate probes use —
 * no new auth code, no new secrets:
 *   - `pollInboxForOtp` / `serverIdFromEmail` from ./lib/mailosaur-otp.mjs
 *     (the single source of truth for Mailosaur OTP retrieval — see that
 *     file's header for why a second copy must never be written).
 *   - The same signUp -> poll mailbox -> verifyOtp flow as
 *     scripts/ci/test-supabase-signup.mjs and scripts/ci/probe-private-media.mjs.
 *   - The same "seed org + active owner membership via the service-role
 *     client" pattern probe-private-media.mjs uses to give a fresh identity
 *     tenant context — here WITHOUT a facility (seedOwnerOrgNoFacility in
 *     artifacts/api-server/src/tests/routes/demo.test.ts is the real
 *     pre-condition the demo fork runs against: TEN-012's owner-org
 *     auto-provision has run, W2's POST /facilities has not).
 *
 * WHAT IT PROVES (see artifacts/api-server/src/routes/demo.ts for the routes
 * under test):
 *
 *   Two mutually exclusive paths, chosen from what GET /api/demo/status
 *   ACTUALLY reports (`enabled`), not from an assumption:
 *
 *   NEGATIVE path (flag observed OFF — the pre-flip / prod-pre-flip case):
 *     - GET /api/demo/status -> enabled:false
 *     - POST /api/demo/provision -> 403 (flag-gated, demo.ts:79-93)
 *     This is the "the flag actually controls it" proof: if a bug ever made
 *     provision ignore the flag, this branch would catch it BEFORE the flag
 *     is ever turned on for real users.
 *
 *   POSITIVE path (flag observed ON — the post-staging-flip gate):
 *     - GET /api/demo/status -> enabled:true
 *     - POST /api/demo/provision -> 200 + a facilityId (a demo facility)
 *     - POST /api/demo/provision AGAIN -> 200, SAME facilityId, and the
 *       admin client confirms exactly one facilities row exists (idempotent
 *       — demo.ts:79-151's `for("update")` + existing-facility short-circuit)
 *     - GET /api/demo/status -> isDemo:true, demoFacilityId === facilityId
 *     - POST /api/demo/graduate {confirm:true} -> 200
 *     - GET /api/demo/status -> isDemo:false, demoFacilityId:null
 *     - Admin-client end-state check (not just the API's word for it):
 *       organizations.is_demo = false AND the facilities row is gone, but
 *       the organization + owner membership themselves survive (matches
 *       demo.test.ts's own graduate assertions). This is the "assert the
 *       end-state" discipline — never trust an HTTP 200 alone for a
 *       state-mutating check.
 *
 *   Set `DEMO_FORK_EXPECT_ENABLED=true|false` to make the branch mismatch
 *   itself a HARD FAILURE (e.g. run with `=true` right after the staging
 *   flip so an unexpectedly-still-off flag fails loudly instead of quietly
 *   taking the negative path and reporting green). Leave unset to
 *   auto-detect and run whichever path the live flag state calls for
 *   (useful for an unattended daily drift check, mirroring
 *   migration-drift-check.yml's OTP probe).
 *
 * ENV (all names REUSED VERBATIM from the already-provisioned staging probe
 * secret set — see docs/runbooks/staging-bootstrap.md Step 7 — no new
 * secrets to provision):
 *   STAGING_SUPABASE_URL                 (variable)
 *   STAGING_SUPABASE_ANON_KEY            (variable)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY    (secret)
 *   STAGING_API_URL                      (variable) — https://farmsmart-api-staging.onrender.com
 *   STAGING_TEST_EMAIL_DOMAIN            (variable)
 *   STAGING_MAILBOX_API_TOKEN            (secret)
 *   STAGING_TEST_PASSWORD                (secret, optional — generated if absent)
 *   STAGING_OTP_TIMEOUT_MS / _INTERVAL_MS (optional tuning, read by mailosaur-otp.mjs)
 * Optional:
 *   DEMO_FORK_EXPECT_ENABLED=true|false  — hard-fail on a flag-state mismatch
 *   PROBE_ENV_PREFIX=STAGING|PRODUCTION  — same prefix-parameterization
 *     convention as probe-private-media.mjs, default STAGING. PRODUCTION is
 *     accepted for symmetry but is NOT provisioned with a probe secret set
 *     today (see the runbook's Step 7 "Production is NOT yet provisioned"
 *     note) — do not point this at prod until that set exists, and even
 *     then only for the negative (flag-off) path pre-flip.
 *
 * Run (from the monorepo root):
 *
 *   STAGING_SUPABASE_URL=... STAGING_SUPABASE_ANON_KEY=... \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=... STAGING_API_URL=... \
 *   STAGING_TEST_EMAIL_DOMAIN=... STAGING_MAILBOX_API_TOKEN=... \
 *   DEMO_FORK_EXPECT_ENABLED=true \
 *   node scripts/ci/probe-demo-fork.mjs
 *
 * MUTATES STAGING (throwaway data only): creates a real Auth identity, an
 * organization, and an active owner membership; the positive path also
 * provisions and then graduates a demo facility (which the graduate step
 * itself tears down). The `finally` block deletes the seeded org (cascades
 * the membership and, if somehow still present, the facility — same FK
 * `organization_id ON DELETE CASCADE` probe-private-media.mjs's cleanup
 * relies on) and the Auth identity, always, best-effort. No real
 * staging/production data is touched — every row this probe reads or writes
 * is scoped to the throwaway org it creates.
 *
 * DO NOT point this at production data you cannot afford to lose.
 */
import { createClient } from "@supabase/supabase-js";
import { pollInboxForOtp } from "./lib/mailosaur-otp.mjs";

// ── Env prefix: STAGING | PRODUCTION (mirrors probe-private-media.mjs) ──────
const PREFIX = (process.env.PROBE_ENV_PREFIX ?? "STAGING").trim().toUpperCase();

// Whitespace-strip, empty-as-absent (mirrors probe-private-media.mjs /
// test-supabase-signup.mjs — Render/GitHub Actions can inject a
// referenced-but-unset secret as "" rather than leaving it undefined).
const env = (name) => {
  const v = process.env[name]?.replace(/\s/g, "");
  return v ? v : undefined;
};

const SUPABASE_URL = env(`${PREFIX}_SUPABASE_URL`);
const SUPABASE_ANON_KEY = env(`${PREFIX}_SUPABASE_ANON_KEY`);
const SUPABASE_SERVICE_ROLE_KEY = env(`${PREFIX}_SUPABASE_SERVICE_ROLE_KEY`);
const API_URL = env(`${PREFIX}_API_URL`);
const TEST_EMAIL_DOMAIN = env(`${PREFIX}_TEST_EMAIL_DOMAIN`);
const MAILBOX_API_TOKEN = env(`${PREFIX}_MAILBOX_API_TOKEN`);

const missing = [
  [`${PREFIX}_SUPABASE_URL`, SUPABASE_URL],
  [`${PREFIX}_SUPABASE_ANON_KEY`, SUPABASE_ANON_KEY],
  [`${PREFIX}_SUPABASE_SERVICE_ROLE_KEY`, SUPABASE_SERVICE_ROLE_KEY],
  [`${PREFIX}_API_URL`, API_URL],
  [`${PREFIX}_TEST_EMAIL_DOMAIN`, TEST_EMAIL_DOMAIN],
  [`${PREFIX}_MAILBOX_API_TOKEN`, MAILBOX_API_TOKEN],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(
    `✗ probe: missing required env var${missing.length > 1 ? "s" : ""} for prefix '${PREFIX}': ${missing.join(", ")}`,
  );
  console.error(
    "  Required per prefix: <PREFIX>_SUPABASE_URL, _SUPABASE_ANON_KEY,",
  );
  console.error(
    "    _SUPABASE_SERVICE_ROLE_KEY, _API_URL, _TEST_EMAIL_DOMAIN, _MAILBOX_API_TOKEN.",
  );
  console.error(`  (active PROBE_ENV_PREFIX=${PREFIX})`);
  process.exit(1);
}

// Never a committed default — only a per-process generated password — so no
// shared secret is ever baked into the repo.
const TEST_PASSWORD =
  env(`${PREFIX}_TEST_PASSWORD`) ??
  `DemoFork-${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}!Aa1`;

const OTP_TIMEOUT_MS = Number(env(`${PREFIX}_OTP_TIMEOUT_MS`) ?? 90_000);

// Optional hard expectation. "" / unset => auto-detect from the live flag.
const RAW_EXPECT = process.env.DEMO_FORK_EXPECT_ENABLED?.trim().toLowerCase();
const EXPECT_ENABLED =
  RAW_EXPECT === "true" ? true : RAW_EXPECT === "false" ? false : null;
if (RAW_EXPECT !== undefined && RAW_EXPECT !== "" && EXPECT_ENABLED === null) {
  console.error(
    `✗ probe: DEMO_FORK_EXPECT_ENABLED must be "true" or "false" if set, got "${RAW_EXPECT}"`,
  );
  process.exit(1);
}

// ── Clients ─────────────────────────────────────────────────────────────────
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Main ────────────────────────────────────────────────────────────────────
const ts = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const email = `demofork-${ts}-${rand}@${TEST_EMAIL_DOMAIN}`;
const signupStartedIso = new Date(ts).toISOString();

let userId = null; // auth.users id == public.users id
let profileCreated = false;
let seededOrgId = null; // org + owner membership seeded so the probe identity has tenant context

const checks = [];

try {
  console.log(`▶ probe target: prefix=${PREFIX} api=${API_URL} supabase=${SUPABASE_URL}`);

  // ── 1. Establish a real authenticated session (signup -> OTP -> verifyOtp) ─
  console.log(`▶ signing up probe identity: ${email}`);
  const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({
    email,
    password: TEST_PASSWORD,
  });
  if (signUpError) throw new Error(`signUp failed: ${signUpError.message}`);
  if (!signUpData.user?.id) {
    throw new Error("signUp returned no user id (identity not created)");
  }
  userId = signUpData.user.id;
  console.log(`✓ signed up; user id = ${userId}`);

  // Skip the OTP poll/verify when signUp() already returned a live session —
  // email confirmation is a per-project Supabase Auth setting; when it's
  // disabled, no confirmation email is ever sent and polling would hang for
  // the full timeout (identical check to the other probes in this dir).
  let session = signUpData.session;
  if (session) {
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
    console.log("✓ OTP retrieved from mailbox");

    console.log("▶ redeeming OTP via auth.verifyOtp");
    const { error: verifyError } = await supabaseAnon.auth.verifyOtp({
      email,
      token: otp,
      type: "signup",
    });
    session = (await supabaseAnon.auth.getSession()).data?.session;
    if (verifyError) {
      const msg = String(verifyError.message ?? "").toLowerCase();
      const tolerable =
        !!session &&
        (msg.includes("already confirmed") ||
          msg.includes("already") ||
          msg.includes("session"));
      if (!tolerable) {
        throw new Error(`verifyOtp failed: ${verifyError.message}`);
      }
      console.log(
        `⚠ verifyOtp returned "${verifyError.message}" but an active session exists (confirmation likely disabled) — proceeding.`,
      );
    } else {
      console.log("✓ OTP verified; session established");
    }
  }
  if (!session) {
    throw new Error("no active session after signUp/verifyOtp — cannot call API");
  }
  const accessToken = session.access_token;

  const { data: profileRows, error: profileError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", userId);
  if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`);
  profileCreated = (profileRows?.length ?? 0) > 0;
  if (!profileCreated) {
    throw new Error(
      "no trigger-created public.users profile exists for the probe identity — Auth pipeline broken",
    );
  }

  // ── 2. Seed org + ACTIVE OWNER membership, NO facility ─────────────────────
  // Mirrors seedOwnerOrgNoFacility in demo.test.ts — the real pre-condition
  // demo.ts's getOwnerOrg requires (an active owner membership), matching the
  // state TEN-012's own owner-org auto-provision leaves a brand-new user in
  // at W2, before POST /facilities has ever run.
  console.log("▶ seeding org + active owner membership (no facility)");
  const { data: orgRows, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .insert({ name: `demofork-probe-${ts}-${rand}` })
    .select("id");
  if (orgErr || !orgRows?.[0]?.id) {
    throw new Error(`could not seed org for the probe: ${orgErr?.message ?? "no id returned"}`);
  }
  seededOrgId = orgRows[0].id;
  const { error: memErr } = await supabaseAdmin
    .from("organization_members")
    .insert({ organization_id: seededOrgId, user_id: userId, role: "owner", status: "active" });
  if (memErr) throw new Error(`could not seed membership for the probe: ${memErr.message}`);
  console.log(`✓ seeded org ${seededOrgId} + owner membership`);

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-FarmSmart-Client-Version": "probe/1",
  };

  async function getDemoStatus() {
    const res = await fetch(`${API_URL}/api/demo/status`, { headers: authHeaders });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GET /api/demo/status failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return { status: res.status, body: await res.json() };
  }

  // ── 3. First status read — decides which path this run takes ───────────────
  console.log("▶ GET /api/demo/status (initial read)");
  const initialStatus = await getDemoStatus();
  const enabledObserved = initialStatus.body?.enabled === true;
  console.log(`  observed enabled=${enabledObserved} isDemo=${initialStatus.body?.isDemo} demoFacilityId=${initialStatus.body?.demoFacilityId}`);

  if (EXPECT_ENABLED !== null) {
    const matches = enabledObserved === EXPECT_ENABLED;
    checks.push({
      name: `DEMO_FORK_ENABLED observed state matches DEMO_FORK_EXPECT_ENABLED=${EXPECT_ENABLED}`,
      ok: matches,
      detail: `observed enabled=${enabledObserved}`,
    });
    if (!matches) {
      // Hard-fail immediately: running the wrong branch against a
      // mismatched flag state would give a false green (e.g. silently
      // taking the negative path when the caller explicitly expected the
      // flag to already be on post-flip).
      throw new Error(
        `flag-state mismatch: expected enabled=${EXPECT_ENABLED} but observed enabled=${enabledObserved} — aborting before running either path`,
      );
    }
  }

  const runPositivePath = enabledObserved;

  if (!runPositivePath) {
    // ── NEGATIVE PATH: flag OFF — the pre-flip / prod-pre-flip proof ─────────
    console.log("▶ flag observed OFF — running the NEGATIVE (pre-flip) path");
    checks.push({
      name: "GET /api/demo/status reports enabled:false",
      ok: !initialStatus.body?.enabled,
      detail: `enabled=${initialStatus.body?.enabled}`,
    });

    console.log("▶ POST /api/demo/provision (expect 403 while flag is off)");
    const provisionRes = await fetch(`${API_URL}/api/demo/provision`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    checks.push({
      name: "POST /api/demo/provision returns 403 while DEMO_FORK_ENABLED is off",
      ok: provisionRes.status === 403,
      detail: `status=${provisionRes.status}`,
    });
    await provisionRes.arrayBuffer().catch(() => {});
  } else {
    // ── POSITIVE PATH: flag ON — the post-flip end-to-end gate ───────────────
    console.log("▶ flag observed ON — running the POSITIVE (post-flip) end-to-end path");
    checks.push({
      name: "GET /api/demo/status reports enabled:true",
      ok: initialStatus.body?.enabled === true,
      detail: `enabled=${initialStatus.body?.enabled}`,
    });

    console.log("▶ POST /api/demo/provision (expect 200 + facilityId)");
    const provisionRes = await fetch(`${API_URL}/api/demo/provision`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const provisionJson = await provisionRes.json().catch(() => ({}));
    const facilityId = provisionJson?.facilityId ?? null;
    checks.push({
      name: "POST /api/demo/provision returns 200 with a facilityId",
      ok: provisionRes.status === 200 && Number.isFinite(facilityId) && facilityId > 0,
      detail: `status=${provisionRes.status} facilityId=${facilityId}`,
    });
    if (!(provisionRes.status === 200 && facilityId)) {
      throw new Error(`provision did not return a usable facilityId (http ${provisionRes.status})`);
    }
    console.log(`✓ provisioned demo facility ${facilityId}`);

    // Idempotency: call again, expect the SAME facilityId and no duplicate row.
    console.log("▶ POST /api/demo/provision again (expect idempotent no-op)");
    const provisionRes2 = await fetch(`${API_URL}/api/demo/provision`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const provisionJson2 = await provisionRes2.json().catch(() => ({}));
    checks.push({
      name: "second POST /api/demo/provision is idempotent (same facilityId)",
      ok: provisionRes2.status === 200 && provisionJson2?.facilityId === facilityId,
      detail: `status=${provisionRes2.status} facilityId=${provisionJson2?.facilityId}`,
    });

    const { data: facilityRows, error: facilityErr } = await supabaseAdmin
      .from("facilities")
      .select("id")
      .eq("organization_id", seededOrgId);
    checks.push({
      name: "admin end-state: exactly one facilities row for the seeded org after two provisions",
      ok: !facilityErr && (facilityRows?.length ?? -1) === 1,
      detail: facilityErr ? facilityErr.message : `count=${facilityRows?.length}`,
    });

    // ── status after provision: isDemo:true, non-null demoFacilityId ─────────
    console.log("▶ GET /api/demo/status (expect isDemo:true)");
    const midStatus = await getDemoStatus();
    checks.push({
      name: "GET /api/demo/status reports isDemo:true after provision",
      ok: midStatus.body?.isDemo === true,
      detail: `isDemo=${midStatus.body?.isDemo}`,
    });
    checks.push({
      name: "GET /api/demo/status reports demoFacilityId === the provisioned facility",
      ok: midStatus.body?.demoFacilityId === facilityId,
      detail: `demoFacilityId=${midStatus.body?.demoFacilityId} expected=${facilityId}`,
    });

    // ── graduate: expect 200 + is_demo flipped back ──────────────────────────
    console.log("▶ POST /api/demo/graduate {confirm:true} (expect 200)");
    const graduateRes = await fetch(`${API_URL}/api/demo/graduate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ confirm: true }),
    });
    await graduateRes.arrayBuffer().catch(() => {});
    checks.push({
      name: "POST /api/demo/graduate {confirm:true} returns 200",
      ok: graduateRes.status === 200,
      detail: `status=${graduateRes.status}`,
    });

    // ── final status: isDemo:false, demoFacilityId:null ──────────────────────
    console.log("▶ GET /api/demo/status (expect isDemo:false, demoFacilityId:null)");
    const finalStatus = await getDemoStatus();
    checks.push({
      name: "GET /api/demo/status reports isDemo:false after graduate",
      ok: finalStatus.body?.isDemo === false,
      detail: `isDemo=${finalStatus.body?.isDemo}`,
    });
    checks.push({
      name: "GET /api/demo/status reports demoFacilityId:null after graduate",
      ok: finalStatus.body?.demoFacilityId === null,
      detail: `demoFacilityId=${finalStatus.body?.demoFacilityId}`,
    });

    // ── admin-client end-state check — never trust the API's word alone ──────
    const { data: orgRowsAfter, error: orgAfterErr } = await supabaseAdmin
      .from("organizations")
      .select("is_demo")
      .eq("id", seededOrgId);
    checks.push({
      name: "admin end-state: organizations.is_demo = false after graduate",
      ok: !orgAfterErr && orgRowsAfter?.[0]?.is_demo === false,
      detail: orgAfterErr ? orgAfterErr.message : `is_demo=${orgRowsAfter?.[0]?.is_demo}`,
    });
    const { data: facilityRowsAfter, error: facilityAfterErr } = await supabaseAdmin
      .from("facilities")
      .select("id")
      .eq("organization_id", seededOrgId);
    checks.push({
      name: "admin end-state: the demo facility row is gone after graduate",
      ok: !facilityAfterErr && (facilityRowsAfter?.length ?? -1) === 0,
      detail: facilityAfterErr ? facilityAfterErr.message : `count=${facilityRowsAfter?.length}`,
    });
    const { data: memRowsAfter, error: memAfterErr } = await supabaseAdmin
      .from("organization_members")
      .select("status")
      .eq("organization_id", seededOrgId)
      .eq("role", "owner");
    checks.push({
      name: "admin end-state: the org + owner membership themselves survive graduate",
      ok: !memAfterErr && memRowsAfter?.[0]?.status === "active",
      detail: memAfterErr ? memAfterErr.message : `status=${memRowsAfter?.[0]?.status}`,
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log("──── demo-fork probe summary ────");
  console.log(`path: ${runPositivePath ? "POSITIVE (flag ON, full provision->graduate flow)" : "NEGATIVE (flag OFF, flag-gate proof)"}`);
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  console.log(`PROBE_RESULT ${failed.length === 0 ? "PASS" : "FAIL"} prefix=${PREFIX} path=${runPositivePath ? "positive" : "negative"}`);

  if (failed.length > 0) {
    console.error(
      `\n✗ FAIL: ${failed.length} check(s) failed: ${failed.map((c) => c.name).join("; ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ PASS: demo-fork ${runPositivePath ? "end-to-end flow" : "flag gate"} verified against ${PREFIX}`);
  }
} catch (err) {
  console.error(`\n✗ FAIL: probe aborted early — ${err?.message ?? err}`);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  console.error("");
  console.error("──── demo-fork probe summary ────");
  console.error(`✗ aborted before all checks ran: ${err?.message ?? err}`);
  for (const c of checks) {
    console.error(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  process.exitCode = 1;
} finally {
  // ── Cleanup (always best-effort, every resource attempted independently) ──
  console.log("");
  console.log("▶ cleanup");
  if (seededOrgId) {
    // Deleting the org cascades the seeded membership and, if the positive
    // path aborted before graduate ran, the still-present demo facility too
    // (facilities.organization_id is ON DELETE CASCADE — same FK
    // probe-private-media.mjs's cleanup relies on).
    const { error: delOrgErr } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", seededOrgId);
    if (delOrgErr) {
      console.error(`⚠ cleanup: failed to delete seeded org ${seededOrgId}: ${delOrgErr.message}`);
    } else {
      console.log(`✓ cleanup: deleted seeded org ${seededOrgId} (cascaded membership + any leftover facility)`);
    }
  }
  if (userId) {
    if (profileCreated) {
      const { error: delProfileError } = await supabaseAdmin
        .from("users")
        .delete()
        .eq("id", userId);
      if (delProfileError) {
        console.error(`⚠ cleanup: failed to delete public.users row for ${userId}: ${delProfileError.message}`);
      } else {
        console.log(`✓ cleanup: deleted public.users row for ${userId}`);
      }
    }
    const { error: delUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delUserError) {
      console.error(`⚠ cleanup: failed to delete Auth user ${userId}: ${delUserError.message}`);
    } else {
      console.log(`✓ cleanup: deleted Auth user ${userId}`);
    }
  }
}
