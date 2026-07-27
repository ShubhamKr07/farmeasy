import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { supabase } from "@/lib/supabase";

export function useSignOutAndClear() {
  const signOut = () => supabase.auth.signOut();
  const queryClient = useQueryClient();
  const router = useRouter();

  return async () => {
    setAuthTokenGetter(null);
    queryClient.clear();
    await signOut();
    router.replace("/sign-in" as any);
  };
}
