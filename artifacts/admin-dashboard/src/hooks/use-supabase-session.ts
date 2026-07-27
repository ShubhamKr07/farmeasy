import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * Subscribe to the Supabase Auth session. Returns the current session (or
 * `null` when signed out) and a `loading` flag that is true until the first
 * `getSession()` resolves. This replaces Clerk's `useAuth()`/`useUser()` and
 * is the single source of auth state for the admin dashboard.
 */
export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}
