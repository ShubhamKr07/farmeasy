/**
 * Private-media probe — Release 1 Task 12 Step 9 / Step 11.
 *
 * End-to-end, against a REAL environment, proves the Task 12 migration
 * actually made the `media` storage bucket private AND that the Task 11
 * signed-URL wiring still serves objects:
 *
 *   1. Establish a real authenticated Supabase Auth session exactly the way
 *      `test-supabase-signup.mjs` does: signUp a fresh identity through the
 *      anon client, poll the Mailosaur test mailbox for the confirmation OTP,
 *      redeem it via `auth.verifyOtp` to get a live session. `pollInboxForOtp`
 *      is imported from the shared ./lib/mailosaur-otp.mjs module — the single
 *      source of truth for Mailosaur OTP retrieval, shared with
 *      test-supabase-signup.mjs so the two scripts can never drift apart.)
 *   2. Upload a tiny in-memory PNG through the LIVE API `POST /api/media/upload`
 *      (multipart `file`). Capture the returned bucket-relative `key`.
 *   3. Persist that `key` through the LIVE API `POST /api/facility-logs`
 *      (logType='waste', photoUrls=[key]). The API stores the raw key and signs
 *      it at the response boundary, so the response's `data.photoUrls[0]` is a
 *      live signed URL (per Task 11 wiring in services/mediaUrls.ts).
 *   4. GET the signed URL — assert 2xx (the bucket is still readable via the
 *      signed path).
 *   5. Construct the exact OLD-STYLE public Storage URL by hand for the same
 *      key and GET it — assert NON-2xx (the bucket is now private; if the
 *      migration never ran or failed, this would wrongly return 2xx and the
 *      probe FAILS, blocking the deploy).
 *   6. `finally`: delete the facility-log row (no DELETE route exists in this
 *      phase — only POST — so delete via the service-role client on the
 *      `facility_logs` table directly), the storage object, the profile, and
 *      the Auth identity. Best-effort, always runs.
 *
 * SECURITY: the signed URL is a live credential-bearing URL. It is NEVER
 * logged, printed, or written to any file. Only non-sensitive diagnostics
 * reach stdout/stderr: HTTP status codes, the SHA-256 hash (first 16 hex) of
 * the object key, and pass/fail of each named check.
 *
 * ENV PREFIX: the SAME script runs against staging and production. Set
 * `PROBE_ENV_PREFIX` to `STAGING` (default) or `PRODUCTION` to select the
 * `${PREFIX}_*` env-var set. Required (per prefix):
 *   ${PREFIX}_SUPABASE_URL
 *   ${PREFIX}_SUPABASE_ANON_KEY
 *   ${PREFIX}_SUPABASE_SERVICE_ROLE_KEY
 *   ${PREFIX}_API_URL
 *   ${PREFIX}_TEST_EMAIL_DOMAIN
 *   ${PREFIX}_MAILBOX_API_TOKEN
 *   ${PREFIX}_TEST_PASSWORD                 (optional; generated if absent)
 *   ${PREFIX}_OTP_TIMEOUT_MS / _INTERVAL_MS (optional tuning)
 * Optional context (persisted into the summary line only, never sensitive):
 *   PROBE_WORKFLOW_ID, PROBE_DEPLOY_SHA, PROBE_DEPLOY_IDS (comma-separated)
 *
 * Run (from the monorepo root):
 *
 *   PROBE_ENV_PREFIX=STAGING \
 *   STAGING_SUPABASE_URL=... STAGING_SUPABASE_ANON_KEY=... \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=... STAGING_API_URL=... \
 *   STAGING_TEST_EMAIL_DOMAIN=... STAGING_MAILBOX_API_TOKEN=... \
 *   node scripts/ci/probe-private-media.mjs
 *
 * DO NOT point this at production data you cannot afford to lose — it creates
 * and deletes a real Auth user, facility-log row, and storage object. The
 * `finally` block is bulletproof-best-effort but a half-cleaned production
 * row (e.g. interrupted runner) leaves a real object in storage.
 */
import { createClient } from "@supabase/supabase-js";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pollInboxForOtp } from "./lib/mailosaur-otp.mjs";

// ── Env prefix: STAGING | PRODUCTION (same script, both envs) ───────────────
const PREFIX = (process.env.PROBE_ENV_PREFIX ?? "STAGING").trim().toUpperCase();

// Whitespace-strip, then treat an empty/whitespace-only value as ABSENT
// (return undefined) so `?? default` fallbacks actually fire. GitHub Actions
// injects a referenced-but-unset secret as an empty string, not undefined —
// e.g. `PRODUCTION_TEST_PASSWORD: ${{ secrets.PRODUCTION_TEST_PASSWORD }}` with
// no such secret set env to "". Without this, `env(...) ?? generated` kept the
// "" (nullish coalescing does not catch empty string) and signUp got an empty
// password ("Signup requires a valid password"). Empty also correctly counts as
// missing for the required-var check below.
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

// (Whitespace strip mirrors api-server/src/middlewares/supabaseAuth.ts — Render
// pastes env vars line-wrapped, embedding a literal newline that breaks the
// apikey/Authorization header. Neither a URL nor a JWT contains whitespace.)

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

// The password never gets a committed default — only a per-process generated
// one — so no shared secret is baked into the repo (the lesson from the deleted
// Clerk credential, mirrored from test-supabase-signup.mjs).
const TEST_PASSWORD =
  env(`${PREFIX}_TEST_PASSWORD`) ??
  `Probe-${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}!Aa1`;

// OTP retrieval budget, surfaced only in the local log string below. The actual
// pollInboxForOtp tuning (timeout + interval) now lives self-contained in
// ./lib/mailosaur-otp.mjs (the single source of truth, shared with the signup
// smoke test).
const OTP_TIMEOUT_MS = Number(env(`${PREFIX}_OTP_TIMEOUT_MS`) ?? 90_000);

// Optional deploy context, persisted into the final summary line ONLY. These
// are non-sensitive identifiers (GitHub run id, git SHA, Render deploy ids).
// Absent in local runs and the staging step (which has no deploy ids to pass).
const PROBE_WORKFLOW_ID = process.env.PROBE_WORKFLOW_ID?.trim() || null;
const PROBE_DEPLOY_SHA = process.env.PROBE_DEPLOY_SHA?.trim() || null;
const PROBE_DEPLOY_IDS = process.env.PROBE_DEPLOY_IDS?.trim() || null;

// ── Clients ─────────────────────────────────────────────────────────────────
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Minimal valid PNG (1×1 RGBA), generated in-script ───────────────────────
// No on-disk fixture and no committed base64 blob to rot. A 1×1 RGBA PNG is
// the smallest image multer's `image/*` filter accepts. Verified locally:
// `file` reports "PNG image data, 1 x 1, 8-bit/color RGBA"; full IHDR/IDAT/IEND
// decode round-trips. CRC32 is table-free (polynomial 0xedb88320).
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function minimalPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // One scanline: filter byte (0) + RGBA (red, opaque).
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00, 0xff]));
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── OTP retrieval (shared, single source of truth) ──────────────────────────
// pollInboxForOtp is imported from ./lib/mailosaur-otp.mjs, the single source
// of truth shared with test-supabase-signup.mjs so the two scripts can never
// drift apart (the probe previously ran a stale copy that read the LIST
// summary body and timed out on the staging deploy gate).

// ── Main ────────────────────────────────────────────────────────────────────
const ts = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const email = `probe-${ts}-${rand}@${TEST_EMAIL_DOMAIN}`;
const signupStartedIso = new Date(ts).toISOString();

// Cleanup handles populated as each resource is created so the `finally` block
// can always attempt removal of whatever actually exists, even if the probe
// aborts partway through.
let userId = null; // auth.users id == public.users id
let profileCreated = false;
let storageKey = null; // the bucket-relative key returned by /media/upload
let facilityLogId = null; // the id of the probe-created facility_logs row
let seededOrgId = null; // org seeded so the probe user has an accessible facility
let facilityId = null; // the seeded facility whose id goes in X-Facility-Id

const checks = [];

try {
  console.log(`▶ probe target: prefix=${PREFIX} api=${API_URL} supabase=${SUPABASE_URL}`);

  // ── 1. Establish a real authenticated session (signup → OTP → verifyOtp) ──
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

  // Skip the OTP poll/verify entirely when signUp() already returned a live
  // session — Email confirmation is a per-project Supabase Auth setting; when
  // it's disabled (staging currently), no confirmation email is ever sent and
  // polling would hang for the full timeout. Checked generically so this same
  // script behaves correctly against production too, whatever its config is.
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
      // type "signup" — this is a fresh-signup confirmation OTP (the email's own
      // verify URL carries type=signup). "email" is for existing-user OTP sign-in
      // and would reject a fresh signup token. Mirrors test-supabase-signup.mjs.
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

  // Confirm the trigger created exactly one profile (mirrors the signup test's
  // invariant; cleanup also depends on this row existing).
  const { data: profileRows, error: profileError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", userId);
  if (profileError) {
    throw new Error(`profile lookup failed: ${profileError.message}`);
  }
  profileCreated = (profileRows?.length ?? 0) > 0;
  if (!profileCreated) {
    throw new Error(
      "no trigger-created public.users profile exists for the probe identity — Auth pipeline broken",
    );
  }

  // TEN-008 scopes facility-logs per-request: POST /api/facility-logs requires
  // an X-Facility-Id header naming a facility the caller is an ACTIVE member of
  // (resolveTenantContext joins organization_members↔facilities). A fresh probe
  // identity has none, so seed an org + active owner membership + one facility
  // via the service-role client. (The media upload itself needs no facility
  // context — only the facility-log persist does.)
  console.log("▶ seeding org + owner membership + facility for tenant context");
  const { data: orgRows, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .insert({ name: `probe-${ts}-${rand}` })
    .select("id");
  if (orgErr || !orgRows?.[0]?.id) {
    throw new Error(`could not seed org for the probe: ${orgErr?.message ?? "no id returned"}`);
  }
  seededOrgId = orgRows[0].id;
  const { error: memErr } = await supabaseAdmin
    .from("organization_members")
    .insert({ organization_id: seededOrgId, user_id: userId, role: "owner", status: "active" });
  if (memErr) throw new Error(`could not seed membership for the probe: ${memErr.message}`);
  const { data: facRows, error: facErr } = await supabaseAdmin
    .from("facilities")
    .insert({ name: "Probe Facility", organization_id: seededOrgId, facility_name: "Probe", timezone: "UTC" })
    .select("id");
  if (facErr || !facRows?.[0]?.id) {
    throw new Error(`could not seed facility for the probe: ${facErr?.message ?? "no id returned"}`);
  }
  facilityId = facRows[0].id;
  console.log(`✓ seeded org ${seededOrgId} + owner membership + facility ${facilityId}`);

  // Shared authenticated headers for the live API.
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "X-FarmSmart-Client-Version": "probe/1",
  };

  // ── 2. Upload a tiny real PNG through the LIVE /api/media/upload ───────────
  console.log("▶ uploading 1×1 PNG via POST /api/media/upload");
  const png = minimalPng();
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "probe.png");

  const uploadRes = await fetch(`${API_URL}/api/media/upload`, {
    method: "POST",
    headers: authHeaders,
    body: form,
  });
  // Do NOT echo the response body (it contains the signed `url`).
  if (!uploadRes.ok) {
    throw new Error(
      `media upload failed: HTTP ${uploadRes.status}`,
    );
  }
  const uploadJson = await uploadRes.json();
  storageKey = uploadJson?.key;
  if (!storageKey || typeof storageKey !== "string") {
    throw new Error(
      `media upload returned no usable 'key' (http ${uploadRes.status})`,
    );
  }
  // Hash the key for logging — the key itself is not sensitive, but hashing it
  // is the explicit Step 11 instruction ("persist only object-key hash"), and
  // it avoids leaking the exact storage path into public logs.
  const keyHash = createHash("sha256").update(storageKey).digest("hex").slice(0, 16);
  console.log(
    `✓ media uploaded: HTTP ${uploadRes.status}, key=<sha256:${keyHash}>`,
  );

  // ── 3. Persist the key through POST /api/facility-logs (logType='waste') ───
  // WasteDataSchema (routes/facilityLogs.ts): wasteType, quantity (>0), unit,
  // disposalMethod (all required); photoUrls (string[], max 4, optional). The
  // API stores the RAW key and signs it at the response boundary (Task 11).
  console.log("▶ persisting key via POST /api/facility-logs (waste)");
  const logRes = await fetch(`${API_URL}/api/facility-logs`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json", "X-Facility-Id": String(facilityId) },
    body: JSON.stringify({
      logType: "waste",
      data: {
        wasteType: "probe",
        quantity: 1,
        unit: "unit",
        disposalMethod: "probe",
        photoUrls: [storageKey],
      },
    }),
  });
  if (!logRes.ok) {
    const detail = await logRes.text().catch(() => "");
    throw new Error(
      `facility-log create failed: HTTP ${logRes.status} ${detail.slice(0, 200)}`,
    );
  }
  const logJson = await logRes.json();
  facilityLogId = logJson?.id ?? null;
  // The response echoes `data.photoUrls` as SIGNED URLs. This is the URL under
  // test. It is NEVER logged — only its HTTP status is.
  const photoUrls = logJson?.data?.photoUrls;
  if (!Array.isArray(photoUrls) || photoUrls.length < 1 || !photoUrls[0]) {
    throw new Error(
      `facility-log create returned no signed photoUrl (http ${logRes.status}, id=${facilityLogId})`,
    );
  }
  const signedUrl = String(photoUrls[0]);
  console.log(`✓ facility-log created: HTTP ${logRes.status}, id=${facilityLogId}`);

  // ── 4. GET the signed URL — must be 2xx (Task 11 signing still works) ─────
  console.log("▶ fetching API-returned signed URL (expect 2xx)");
  const signedRes = await fetch(signedUrl, { method: "GET" });
  // Read+discard the body so the response is fully consumed but never echoed.
  await signedRes.arrayBuffer().catch(() => {});
  const signedOk = signedRes.ok;
  checks.push({
    name: "signed URL returns 2xx (object still readable via signed path)",
    ok: signedOk,
    detail: `status=${signedRes.status} content-type=${signedRes.headers.get("content-type") ?? "<none>"}`,
  });
  console.log(
    `${signedOk ? "✓" : "✗"} signed-URL fetch: status=${signedRes.status}`,
  );

  // ── 5. GET the OLD-STYLE public URL — must be NON-2xx (bucket is private) ─
  // Construct by hand exactly as the migration's backfill matched legacy rows:
  // https://<host>.supabase.co/storage/v1/object/public/media/<key>. If the
  // migration never ran / failed, the bucket is still public and this returns
  // 2xx with the image bytes — the probe FAILS and blocks the deploy.
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/media/${storageKey}`;
  console.log("▶ fetching constructed public URL (expect NON-2xx)");
  const publicRes = await fetch(publicUrl, { method: "GET", redirect: "error" }).catch(
    // A redirect would itself be a "not the public bytes" outcome; treat as
    // non-2xx (private). Log whatever happened.
    (e) => ({ ok: false, status: -1, arrayBuffer: async () => {}, headers: new Headers(), _err: String(e?.message ?? e) }),
  );
  await publicRes.arrayBuffer?.().catch(() => {});
  const publicIs2xx = publicRes.ok === true;
  const publicBlocked = !publicIs2xx;
  checks.push({
    name: "public Storage URL returns NON-2xx (bucket is private)",
    ok: publicBlocked,
    detail:
      "status=" +
      (publicRes.status === -1 ? `redirect/error (${publicRes._err ?? "n/a"})` : publicRes.status),
  });
  console.log(
    `${publicBlocked ? "✓" : "✗"} public-URL fetch: status=${publicRes.status === -1 ? "redirect/error" : publicRes.status} (expected non-2xx)`,
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log("──── private-media probe summary ────");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  // Persist ONLY the allowed, non-sensitive set (Step 11): object-key hash,
  // HTTP statuses, and — when provided by the workflow — deploy identifiers.
  const ctxParts = [
    `prefix=${PREFIX}`,
    `key=<sha256:${keyHash}>`,
    `signed_status=${signedRes.status}`,
    `public_status=${publicRes.status === -1 ? "non2xx(redirect/error)" : publicRes.status}`,
  ];
  if (PROBE_WORKFLOW_ID) ctxParts.push(`workflow_id=${PROBE_WORKFLOW_ID}`);
  if (PROBE_DEPLOY_SHA) ctxParts.push(`sha=${PROBE_DEPLOY_SHA}`);
  if (PROBE_DEPLOY_IDS) ctxParts.push(`deploy_ids=${PROBE_DEPLOY_IDS}`);
  if (facilityLogId) ctxParts.push(`log_id=${facilityLogId}`);
  console.log(`PROBE_RESULT ${failed.length === 0 ? "PASS" : "FAIL"} ${ctxParts.join(" ")}`);

  if (failed.length > 0) {
    console.error(
      `\n✗ FAIL: ${failed.length} check(s) failed: ${failed.map((c) => c.name).join("; ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ PASS: media bucket is private AND signed-URL wiring works (${PREFIX})`);
  }
} catch (err) {
  console.error(`\n✗ FAIL: probe aborted early — ${err?.message ?? err}`);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  console.error("");
  console.error("──── private-media probe summary ────");
  console.error(`✗ aborted before all checks ran: ${err?.message ?? err}`);
  for (const c of checks) {
    console.error(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  process.exitCode = 1;
} finally {
  // ── Cleanup (always best-effort, every resource attempted independently) ──
  // Production note: this runs against REAL data and incurs REAL storage cost
  // if it is skipped. Each branch is independent so a failure deleting one
  // resource cannot mask deletion of another. Never throws — only logs.
  console.log("");
  console.log("▶ cleanup");
  if (facilityLogId) {
    // No DELETE route exists for facility-logs in this phase (only POST); the
    // brief's Step 9 directed deleting directly via the service-role client,
    // same authority test-supabase-signup.mjs uses for profile cleanup.
    const { error: delLogError } = await supabaseAdmin
      .from("facility_logs")
      .delete()
      .eq("id", facilityLogId);
    if (delLogError) {
      console.error(
        `⚠ cleanup: failed to delete facility_logs row ${facilityLogId}: ${delLogError.message}`,
      );
    } else {
      console.log(`✓ cleanup: deleted facility_logs row ${facilityLogId}`);
    }
  }
  if (seededOrgId) {
    // Delete the org AFTER the facility_logs row above (which references the
    // facility). The org delete cascades the seeded facility + membership
    // (both FK organization_id ON DELETE CASCADE).
    const { error: delOrgErr } = await supabaseAdmin
      .from("organizations")
      .delete()
      .eq("id", seededOrgId);
    if (delOrgErr) {
      console.error(`⚠ cleanup: failed to delete seeded org ${seededOrgId}: ${delOrgErr.message}`);
    } else {
      console.log(`✓ cleanup: deleted seeded org ${seededOrgId} (cascaded facility + membership)`);
    }
  }
  if (storageKey) {
    const { error: delObjError } = await supabaseAdmin.storage
      .from("media")
      .remove([storageKey]);
    if (delObjError) {
      console.error(
        `⚠ cleanup: failed to remove storage object for key=<sha256:${createHash("sha256").update(storageKey).digest("hex").slice(0, 16)}>: ${delObjError.message}`,
      );
    } else {
      console.log("✓ cleanup: removed storage object");
    }
  }
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
