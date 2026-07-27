import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type UserRole, USER_ROLE_LABELS, isSupervisorOrLead } from "@workspace/api-zod";

export type { UserRole };

export function useUserRole(): {
  role: UserRole;
  label: string;
  isSupervisor: boolean;
} {
  const [role, setRole] = useState<UserRole>("technician");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const claimRole = (data.session as any)?.user_role as UserRole | undefined;
      if (claimRole) setRole(claimRole);
    });
  }, []);

  return {
    role,
    label: USER_ROLE_LABELS[role] ?? "Technician",
    isSupervisor: isSupervisorOrLead(role),
  };
}
