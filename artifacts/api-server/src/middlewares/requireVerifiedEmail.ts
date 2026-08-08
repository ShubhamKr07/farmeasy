import type { Request, Response, NextFunction } from "express";
import { getAuth } from "./supabaseAuth";

/**
 * Backend email-verification gate (TEN-012 Task 6) — defense-in-depth.
 *
 * The PRIMARY control is Supabase itself: in production GoTrue is configured to
 * require email confirmation, so it refuses to issue a session (no access
 * token) until the address is confirmed. Verified empirically against this
 * repo's disposable GoTrue: `signInWithPassword` for an `email_confirm:false`
 * user fails with "Email not confirmed" — no token is ever minted. This
 * middleware is the SECONDARY control: even if a token for an unverified
 * account somehow reaches us, nothing past the "Check your inbox" interstitial
 * renders server-side.
 *
 * The verification signal is `payload.user_metadata.email_verified` (a boolean;
 * there is no `email_confirmed_at` claim and no top-level `email_verified` in
 * this GoTrue's tokens) — surfaced by supabaseAuth.ts as `emailVerified`.
 *
 * DECISION — block ONLY when the claim is explicitly `false`:
 *   - `false`     → 403 EMAIL_UNVERIFIED (explicitly unverified).
 *   - `true`      → next() (verified).
 *   - `undefined` → next() (claim ABSENT). We deliberately fail OPEN on
 *     absence and lean on the primary confirm-email-required control. Failing
 *     closed on an absent claim would lock out legitimately-verified users
 *     whose tokens simply omit the field (e.g. a future GoTrue/JWT-template
 *     change, or a non-password identity provider) — a worse failure mode than
 *     the narrow, already-primary-guarded gap of an absent-claim unverified
 *     token slipping through. Absence is not evidence of non-verification.
 */
export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction) {
  const { emailVerified } = getAuth(req);
  if (emailVerified === false) {
    res.status(403).json({ code: "EMAIL_UNVERIFIED" });
    return;
  }
  next();
}
