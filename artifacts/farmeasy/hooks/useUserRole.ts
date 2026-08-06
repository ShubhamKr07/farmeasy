import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type UserRole, USER_ROLE_LABELS, isPrivileged } from "@workspace/api-zod";

export type { UserRole };

// Reads the custom `user_role` claim Task 1's auth hook injects into the JWT
// (supabase/migrations/00001_custom_access_token_hook.sql), repointed in
// TEN-010 Task 8 from the deprecated operational axis
// (technician|supervisor|quality_lead|facility_lead) to the org membership
// role (owner|admin|technician) — the single source of truth. getClaims()
// verifies the JWT locally and is the supported claims API; getSession()'s
// claim access relied on an unchecked `as any` cast into session shape that
// Supabase never actually guaranteed. Absent claim defaults to technician,
// matching the server-side default the profile trigger assigns.
export async function getUserRole(): Promise<UserRole> {
  const { data, error } = await supabase.auth.getClaims();
  if (error) throw error;
  return (data?.claims.user_role as UserRole | undefined) ?? "technician";
}

export function useUserRole(): {
  role: UserRole;
  label: string;
  isPrivileged: boolean;
} {
  const [role, setRole] = useState<UserRole>("technician");

  useEffect(() => {
    getUserRole().then(setRole);
  }, []);

  return {
    role,
    label: USER_ROLE_LABELS[role] ?? "Technician",
    isPrivileged: isPrivileged(role),
  };
}
