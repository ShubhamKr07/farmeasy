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
 * Derive the Mailosaur server id from the test recipient address.
 *
 * Mailosaur routes every `<local>@<serverId>.mailosaur.net` message to server
 * `<serverId>`, so the subdomain label IS the server id — the authoritative
 * source of where the mail actually landed.
 *
 * WHY NOT "take the account's first server": Mailosaur keys are account-scoped,
 * and this account has MULTIPLE servers on purpose (a `FarmSmart Production
 * Probe` server for prod probes and a `FarmSmart Samplings` server for the
 * staging gate). The previous resolver returned `items[0]` from GET
 * /api/servers, which happened to be the prod-probe server — so the staging
 * signup email landed in the samplings server while the poll watched the empty
 * prod-probe server, timing out the full OTP budget on every staging deploy.
 * Routing by the address the email was actually sent to fixes both envs, since
 * each already emails to its own `*.mailosaur.net` subdomain.
 *
 * @param {string} toEmail e.g. `signup-…@c87jrlkh.mailosaur.net`
 * @returns {string}
 */
export function serverIdFromEmail(toEmail) {
  const domain = String(toEmail).split("@")[1] ?? "";
  const m = domain.match(/^([^.\s]+)\.mailosaur\.(net|io|com)$/i);
  if (!m) {
    throw new Error(
      `cannot derive Mailosaur server id from "${toEmail}" — expected ` +
        `<local>@<serverId>.mailosaur.net`,
    );
  }
  return m[1];
}

/**
 * Remove URLs (and href/src attribute values) from a body string, replacing
 * each with a space. Digits living inside a URL — Resend click-tracking ids,
 * `redirect_to`/`token_hash` params, `127.0.0.1` ports — must NEVER be mistaken
 * for the 6-digit OTP. Since TEN-012 routed Supabase Auth email through Resend,
 * confirmation emails carry click-tracking URLs whose numeric segments are the
 * exact source of the intermittent "Token has expired or is invalid" failures.
 */
function stripUrls(text) {
  return String(text ?? "")
    .replace(/\b(?:href|src)\s*=\s*["'][^"']*["']/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ");
}

/** Extract a 6-digit confirmation code from an email body. */
export function extractOtp(body) {
  if (!body) return null;
  // Strip HTML tags + common entities, THEN strip URLs. Tag-stripping alone
  // leaves bare URLs in visible text / plain-text parts, whose digit runs would
  // otherwise be matched as the code. Supabase's OTP templates also render the
  // 6 digits across styled cells (`<td>1</td><td>2</td>…`), so collapsing tags
  // to spaces (and later stripping the spaces for the digit scan) keeps a split
  // code matchable.
  const text = stripUrls(
    String(body)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " "),
  );
  // Prefer a code introduced by a label Supabase's template uses.
  const labeled = text.match(
    /(?:code|otp|verification|token)[^\d]{0,20}(\d{6})/i,
  );
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
 * Collect every URL referenced anywhere in a Mailosaur message: link hrefs plus
 * bare URLs and href/src attributes in the text/html bodies. Used to reject any
 * candidate 6-digit code that is merely a substring of a URL.
 */
function collectUrls(full) {
  const urls = [];
  const links = [...(full?.html?.links ?? []), ...(full?.text?.links ?? [])];
  for (const l of links) if (l?.href) urls.push(String(l.href));
  for (const body of [full?.text?.body, full?.html?.body]) {
    const s = String(body ?? "");
    for (const m of s.matchAll(/https?:\/\/\S+/gi)) urls.push(m[0]);
    for (const m of s.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi))
      urls.push(m[1]);
  }
  return urls;
}

/**
 * Extract the 6-digit OTP from a full Mailosaur message, trying every place a
 * Supabase confirmation template may put `{{ .Token }}`: inline in the
 * plain-text part ("Here's your token [930619]"), as the text of a link whose
 * href IS the token (`<a href="930619">`), and in Mailosaur's auto-detected
 * `codes` array.
 *
 * Candidate order is deliberate. The plain-text body is tried FIRST because it
 * has no click-tracking markup; the `codes` array is tried LAST and any
 * candidate that is merely a substring of a URL in the message is rejected.
 * That guards two misfires: Mailosaur picking "127" from a `127.0.0.1` redirect,
 * and — since TEN-012 routed Supabase Auth email through Resend — Mailosaur
 * auto-detecting a 6-digit Resend click-tracking id as a "code". Trusting that
 * misfire returned a non-token value that verifyOtp rejected as expired/invalid,
 * the intermittent deploy-staging gate failure this ordering fixes.
 *
 * @returns {string | null}
 */
export function extractOtpFromMessage(full) {
  // Every URL in the message. A 6-digit value that is only a substring of one of
  // these is a tracking id / redirect param / port — never the OTP.
  const urls = collectUrls(full);
  const inUrl = (code) => code != null && urls.some((u) => u.includes(code));

  // 1. Strongest signal: a code in the PLAIN-TEXT body. The text/* part carries
  //    the Supabase template's inline "token [nnnnnn]" and has no click-tracking
  //    markup; extractOtp strips any bare URLs, so a tracking id cannot win here.
  //    This deliberately runs BEFORE the codes[] path — Resend tracking URLs make
  //    Mailosaur mis-detect a URL's digits as a "code", which is exactly the
  //    misfire that returned an expired/invalid token to verifyOtp.
  const fromText = extractOtp(full?.text?.body);
  if (fromText && !inUrl(fromText)) return fromText;

  // 2. A link whose href is the bare token (older template renders OTP as a URL).
  const links = [...(full?.html?.links ?? []), ...(full?.text?.links ?? [])];
  for (const l of links) {
    const m = String(l?.href ?? "").match(/^\s*(\d{6})\s*$/);
    if (m) return m[1];
  }

  // 3. Mailosaur auto-detected codes — 6-digit only AND not a substring of any
  //    URL, so noise like "127" (127.0.0.1) or a Resend tracking id is rejected.
  const codes = [...(full?.text?.codes ?? []), ...(full?.html?.codes ?? [])];
  for (const c of codes) {
    const m = String(c?.value ?? "").match(/\b\d{6}\b/);
    if (m && !inUrl(m[0])) return m[0];
  }

  // 4. Last resort: scan the HTML body / subject (tags + URLs stripped).
  for (const body of [full?.html?.body, full?.subject]) {
    const otp = extractOtp(body);
    if (otp && !inUrl(otp)) return otp;
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
  const serverId = serverIdFromEmail(toEmail);
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
        const mres = await fetch(
          `https://mailosaur.com/api/messages/${summary.id}`,
          {
            headers: { Authorization: auth },
          },
        );
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
