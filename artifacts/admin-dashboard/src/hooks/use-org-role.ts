import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type OrgRole = "owner" | "admin" | "technician";

/**
 * Resolves the signed-in user's organization role from the `user_role` JWT
 * claim (TEN-010). Post Task 8, `custom_access_token_hook` injects the
 * `organization_members.role` value (owner/admin/technician) as that claim —
 * the single source of truth per ADR-005 — so this is the ORG role, not the
 * deprecated per-facility operational role the hook used to carry.
 *
 * Returns `{ role, loading }` so callers can distinguish "still resolving the
 * claim" from "resolved to no role":
 *  - `loading === true`: the role is not yet known — the first `getClaims()`
 *    resolution is still in flight (initial mount, before the claim round-trip
 *    completes). Callers MUST NOT treat this as "technician" (that would flash
 *    a false AUTH-003 denied screen for an owner/admin) nor as a privileged
 *    role (that would flash a privileged UI). Render a loading state and gate
 *    on `loading === false` before branching on `role`.
 *  - `loading === false && role === null`: the claim resolved and there is
 *    genuinely no active org membership / recognized role for this session
 *    (signed-out, no active membership, or an unrecognized claim value).
 *  - `loading === false && role === "owner" | "admin" | "technician"`: the
 *    resolved org role.
 *
 * `supabase.auth.getClaims()` is async (it verifies the JWT — a cached JWKS
 * request when asymmetric signing is configured, else a round-trip like
 * getUser). We re-resolve on every auth state change so a fresh sign-in /
 * role change is reflected without a reload, matching the
 * `use-supabase-session` subscription pattern. `loading` is `true` only until
 * the FIRST resolution completes; subsequent re-resolutions triggered by
 * `onAuthStateChange` update `role` in place without flipping `loading` back
 * (the hook already holds a resolved value to display in the meantime).
 *
 * The server-side 403 (requireRole) remains the real control; this is just
 * the directing UX layer.
 */
export function useOrgRole(): { role: OrgRole | null; loading: boolean } {
  const [role, setRole] = useState<OrgRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const resolve = async () => {
      const { data } = await supabase.auth.getClaims();
      if (!active) return;
      // `claims` is a jose JwtPayload (index-signature record). Read the
      // injected claim directly; treat any unrecognized value as "no role".
      const claims = data?.claims as { user_role?: unknown } | undefined;
      const value = claims?.user_role;
      setRole(
        value === "owner" || value === "admin" || value === "technician" ? value : null,
      );
      setLoading(false);
    };

    void resolve();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      void resolve();
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return { role, loading };
}
