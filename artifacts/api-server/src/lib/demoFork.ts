/**
 * Feature flag for the TEN-013 demo fork ("Set up your farm" vs "Explore a
 * demo" at onboarding W2). Read from `process.env.DEMO_FORK_ENABLED`,
 * case-insensitive. Any value other than "true" — including unset — disables
 * the fork (fail-closed, same discipline as SIGNUP_MODE). While off, W2 opens
 * directly on farm_basics and POST /api/demo/provision is inert.
 *
 * NOTE: only the provision path and the fork UI are gated by this flag. Demo
 * graduation (POST /api/demo/graduate) and GET /api/demo/status are always
 * available so a user already in a demo org can never be trapped if the flag
 * is later switched off.
 */
export function isDemoForkEnabled(): boolean {
  return (process.env.DEMO_FORK_ENABLED ?? "").toLowerCase() === "true";
}
