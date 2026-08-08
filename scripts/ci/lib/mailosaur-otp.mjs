/**
 * Single source of truth for Mailosaur OTP retrieval.
 *
 * Shared by the hosted-Auth signup smoke test
 * (scripts/ci/test-supabase-signup.mjs) and the private-media deploy-gate probe
 * (scripts/ci/probe-private-media.mjs).
 *
 * WHY THIS EXISTS: the Mailosaur inbox-polling + OTP-extraction logic was
 * duplicated across those two scripts (and a third, scripts/ci/verify-staging-
 * supabase.mjs, whose OTP redemption is currently commented out). A fix —
 * fetching the FULL message via GET /api/messages/{id} and extracting the code
 * via extractOtpFromMessage (which handles a token rendered as a bare-link
 * href, Mailosaur's text/html .codes array, and an HTML-tag/entity-stripped
 * body scan with a whitespace-collapsed last resort) — landed in ONLY
 * test-supabase-signup.mjs. The probe still ran the OLD copy, which read
 * msg.html from the LIST (summary) endpoint and regexed a raw summary body, so
 * it timed out on the staging deploy gate for the exact reason the signup test
 * had already been fixed. Consolidating here means a fix can never again land
 * in only one copy. See docs/testing/auth-and-persistent-env-testing.md, rule 1
 * (a dependent-assertion sweep when auth/mailbox semantics change).
 *
 * OTP retrieval tuning (operational, not secrets) is read HERE so
 * pollInboxForOtp is fully self-contained (same env vars + defaults the two
 * scripts used locally):
 *   STAGING_OTP_TIMEOUT_MS   (default 90000)
 *   STAGING_OTP_INTERVAL_MS  (default 3000)
 */

const OTP_TIMEOUT_MS = Number(process.env.STAGING_OTP_TIMEOUT_MS ?? 90_000);
const OTP_INTERVAL_MS = Number(process.env.STAGING_OTP_INTERVAL_MS ?? 3_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export async function resolveMailosaurServerId(token) {
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
export function extractOtp(body) {
  if (!body) return null;
  // Strip HTML tags + common entities first. Supabase's OTP templates render
  // the 6 digits across styled cells (`<td>1</td><td>2</td>…`), which would
  // break a `\d{6}` match against raw HTML; collapsing tags to spaces (and
  // then stripping the spaces for the digit scan) makes a split code matchable.
  const text = String(body)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
  // Prefer a code introduced by a label Supabase's template uses.
  const labeled = text.match(/(?:code|otp|verification|token)[^\d]{0,20}(\d{6})/i);
  if (labeled) return labeled[1];
  // Fallback: the first standalone 6-digit run.
  const plain = text.match(/\b(\d{6})\b/);
  if (plain) return plain[1];
  // Last resort: digits separated only by whitespace (styled per-digit cells
  // collapsed above), e.g. "1 2 3 4 5 6" → "123456".
  const spaced = text.replace(/\s+/g, "").match(/\d{6}/);
  return spaced ? spaced[0] : null;
}

/**
 * Extract the 6-digit OTP from a full Mailosaur message, trying every place a
 * Supabase confirmation template may put `{{ .Token }}`. The staging template
 * renders it three ways at once: as the text of a link whose href IS the token
 * (`<a href="930619">Here's your token</a>`), and inline in the plain-text part
 * ("Here's your token [930619]"). Mailosaur's own `codes` detection misfires
 * here — it classifies the token-link as a link (not a code) and instead picks
 * "127" out of the `127.0.0.1` redirect URL — so the code-array path is guarded
 * by a strict 6-digit test and backed by explicit link/body scans.
 *
 * @returns {string | null}
 */
export function extractOtpFromMessage(full) {
  // 1. Mailosaur auto-detected codes — 6-digit only, so noise like "127"
  //    (from 127.0.0.1) is rejected.
  const codes = [...(full?.text?.codes ?? []), ...(full?.html?.codes ?? [])];
  for (const c of codes) {
    const m = String(c?.value ?? "").match(/\b\d{6}\b/);
    if (m) return m[0];
  }
  // 2. A link whose href is the bare token (template renders the OTP as a URL).
  const links = [...(full?.html?.links ?? []), ...(full?.text?.links ?? [])];
  for (const l of links) {
    const m = String(l?.href ?? "").match(/^\s*(\d{6})\s*$/);
    if (m) return m[1];
  }
  // 3. Scan the bodies. text.body carries the token inline ("token [930619]");
  //    html.body may only have it in a stripped href attr, so check text first.
  for (const body of [full?.text?.body, full?.html?.body, full?.subject]) {
    const otp = extractOtp(body);
    if (otp) return otp;
  }
  return null;
}

/**
 * Poll the test mailbox until a confirmation email for `toEmail` arrives after
 * `sinceIso`, then return the 6-digit OTP from its body.
 *
 * @param {{ token: string, toEmail: string, sinceIso: string }} args
 * @returns {Promise<string>}
 */
export async function pollInboxForOtp({ token, toEmail, sinceIso }) {
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
    for (const summary of items) {
      // The LIST endpoint returns message *summaries* without the full body;
      // the html/text bodies, links, and Mailosaur's auto-detected `codes` only
      // come from GET /api/messages/{id}. Fetch the full message so the OTP is
      // actually present to extract.
      let full = summary;
      if (summary.id) {
        const mres = await fetch(`https://mailosaur.com/api/messages/${summary.id}`, {
          headers: { Authorization: auth },
        });
        if (mres.ok) {
          full = await mres.json();
        }
      }
      const otp = extractOtpFromMessage(full);
      if (otp) return otp;
    }
    await sleep(OTP_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${OTP_TIMEOUT_MS}ms waiting for OTP email to ${toEmail} ` +
      `(last inbox poll saw ${lastSeen} matching message(s)).`,
  );
}
