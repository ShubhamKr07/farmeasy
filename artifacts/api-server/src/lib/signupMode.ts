/**
 * Sign-up gating mode for public sign-up (TEN-012).
 *
 * Read from `process.env.SIGNUP_MODE` (case-insensitive). Any unrecognized or
 * missing value defaults to `"off"` — closed — so a misconfigured deploy can
 * never accidentally open sign-up. The GET /auth/signup-availability route
 * (routes/auth.ts) consumes this to tell the UI which entry point to show.
 *
 *   "off"       — sign-up is closed (no public sign-up at all).
 *   "allowlist" — only emails present in `signup_allowlist` may sign up.
 *   "public"    — anyone may sign up.
 */
export type SignupMode = "off" | "allowlist" | "public";

export function getSignupMode(): SignupMode {
  const v = (process.env.SIGNUP_MODE ?? "off").toLowerCase();
  return v === "allowlist" || v === "public" ? v : "off";
}
