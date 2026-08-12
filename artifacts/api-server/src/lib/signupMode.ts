import { eq } from "drizzle-orm";
import { db, signupConfigTable } from "@workspace/db";

/**
 * Sign-up gating mode for public sign-up (TEN-011/TEN-012).
 *
 *   "off"       — sign-up is closed (no public sign-up at all).
 *   "allowlist" — only emails present in `signup_allowlist` may sign up.
 *   "public"    — anyone may sign up.
 *
 * DB-AUTHORITATIVE (TEN-011): `public.signup_config` (the singleton `id=1`
 * row, `lib/db/drizzle/0034_signup_config.sql`) is the single source of
 * truth. The `before_user_created` Postgres hook
 * (`supabase/migrations/00025_signup_enforcement.sql`) reads the SAME row to
 * actually enforce the mode server-side — this function and the hook can
 * never drift, because they're reading the same row rather than two
 * independently-configured signals (an app env var + a hook-local value).
 * Flipping the mode is therefore instant and atomic (an UPDATE), with no
 * redeploy.
 *
 * `SIGNUP_MODE` (env) is NOT read here in the normal path — it was only ever
 * the migration's seed value (0034 seeds the row `mode='off'` from this same
 * default) and is kept as a documented, defensive fallback for the case
 * where the singleton row is somehow missing (it should never be, post-
 * migration) rather than a live, request-time source of truth.
 *
 * No caching: this is a single indexed primary-key lookup (negligible cost)
 * behind an already rate-limited public endpoint (GET /auth/signup-
 * availability's `availabilityLimiter`, 60/15min) — caching would trade a
 * negligible perf win for exactly the staleness risk DB-authoritative mode
 * exists to eliminate (flip the row, see it reflected immediately).
 */
export type SignupMode = "off" | "allowlist" | "public";

function normalizeMode(value: unknown): SignupMode {
  return value === "allowlist" || value === "public" ? value : "off";
}

export async function getSignupMode(): Promise<SignupMode> {
  const [row] = await db
    .select({ mode: signupConfigTable.mode })
    .from(signupConfigTable)
    .where(eq(signupConfigTable.id, 1))
    .limit(1);

  if (row) return normalizeMode(row.mode);

  // Defensive fallback ONLY — the singleton row should always exist after
  // 0034's migration seed. Never defaults to anything but the safe "off"
  // domain (normalizeMode), matching the pre-TEN-011 env-only behavior.
  return normalizeMode((process.env.SIGNUP_MODE ?? "off").toLowerCase());
}
