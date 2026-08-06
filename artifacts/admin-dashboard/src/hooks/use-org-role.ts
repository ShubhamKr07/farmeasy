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
 * Returns `"owner" | "admin" | "technician"`, or `null` while the role is
 * still resolving (initial load, no session, no active membership, or a
 * `getClaims()` failure). Callers that gate UI on privilege MUST treat `null`
 * as "not privileged" (hide the surface) — never assume a default — since a
 * technician or an unresolved state must never flash a privileged UI. The
 * server-side 403 (requireRole) remains the real control; this is just the
 * directing UX layer.
 *
 * `supabase.auth.getClaims()` is async (it verifies the JWT — a cached JWKS
 * request when asymmetric signing is configured, else a round-trip like
 * getUser). We re-resolve on every auth state change so a fresh sign-in /
 * role change is reflected without a reload, matching the
 * `use-supabase-session` subscription pattern.
 */
export function useOrgRole(): OrgRole | null {
  const [role, setRole] = useState<OrgRole | null>(null);

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

  return role;
}
