import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  // PKCE flow returns `?code=` in the query string (survives redirects/reloads
  // better than the implicit flow's URL fragment). We disable the client's
  // automatic in-URL detection and exchange the code explicitly on mount
  // (see OAuthCallbackHandler in App.tsx) — the automatic path was silently
  // failing to establish a session on the deployed build.
  auth: { flowType: "pkce", detectSessionInUrl: false },
});
