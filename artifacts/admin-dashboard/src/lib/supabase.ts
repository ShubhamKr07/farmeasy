import { createClient } from "@supabase/supabase-js";

// Strip ALL whitespace from the env values. The Render `VITE_SUPABASE_ANON_KEY`
// was entered line-wrapped, embedding a newline + spaces in the middle of the
// JWT. Vite inlines that verbatim at build time, and Supabase sends the key as
// the `apikey` HTTP header — a header value containing a newline makes the
// browser throw `Failed to execute 'fetch' on 'Window': Invalid value`, so
// EVERY Supabase request (all sign-in methods included) failed on the deployed
// build. A JWT / URL contains no legitimate whitespace, so stripping it is safe
// and makes the client robust regardless of how the env var was pasted.
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\s/g, "");
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string).replace(/\s/g, "");

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  // PKCE flow returns `?code=` in the query string (survives redirects/reloads
  // better than the implicit flow's URL fragment). We disable the client's
  // automatic in-URL detection and exchange the code explicitly on mount
  // (see OAuthCallbackHandler in App.tsx).
  auth: { flowType: "pkce", detectSessionInUrl: false },
});
