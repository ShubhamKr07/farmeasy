import { useEffect, useState } from "react";

/**
 * TEN-012 Task 9: debounced probe of `GET /auth/signup-availability`.
 *
 * The AuthGate's "Create an account" path needs to know, given the email the
 * user just typed, whether sign-up is open / allowlisted / closed so it can
 * render Create-account vs. a Request-access placeholder (Task 11). The
 * endpoint is PUBLIC (mounted above the requireSignedIn gate in api-server's
 * app.ts), so this hook fetches it with NO bearer token.
 *
 * The API base URL is resolved the SAME way every other dashboard request
 * resolves it: `import.meta.env.VITE_API_BASE_URL` (see App.tsx, which calls
 * `setBaseUrl(apiBaseUrl)` on the generated client). That env var supplies only
 * the API *host*; every endpoint path — generated or hand-written — carries its
 * own `/api/...` prefix (the router is mounted under `/api` in app.ts). So this
 * probe hits `/api/auth/signup-availability`, matching the server route and the
 * api-server tests. When the env var is unset the prefix is empty and the path
 * is same-origin-relative, still under `/api`.
 *
 * Plain `fetch` (not the generated client) per the task brief: Task 12 will
 * swap this for a codegen hook once the openapi spec lists /auth/*.
 */
export type SignupMode = "off" | "allowlist" | "public";

export interface SignupAvailability {
  mode: SignupMode | null;
  allowed: boolean;
  loading: boolean;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

/**
 * Builds the same-origin-or-prefixed URL for a dashboard API path, matching
 * the generated client's own `applyBaseUrl` (custom-fetch.ts): empty prefix
 * for a relative (same-origin) request, otherwise the env-supplied origin.
 */
export function apiUrl(path: string): string {
  const prefix = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, "") : "";
  return `${prefix}${path}`;
}

export function useSignupAvailability(email: string): SignupAvailability {
  const [state, setState] = useState<SignupAvailability>({
    mode: null,
    allowed: false,
    loading: false,
  });

  useEffect(() => {
    const trimmed = email.trim();
    // Nothing meaningful to probe yet — reset and skip the request entirely.
    if (!trimmed) {
      setState({ mode: null, allowed: false, loading: false });
      return;
    }

    // `cancelled` is effect-scoped so the effect's cleanup (below) can flip it:
    // when the email changes while a probe is already in flight (debounce timer
    // already fired), clearTimeout is a no-op, so this flag is what prevents a
    // stale response from overwriting state for a newer email.
    let cancelled = false;

    // Debounce ~300ms so each keystroke doesn't fire a probe.
    const handle = window.setTimeout(() => {
      // Mark loading inside the timer so the spinner only shows for an actual
      // in-flight probe, not the idle gap while the user is still typing.
      setState((prev) => ({ ...prev, loading: true }));
      void (async () => {
        try {
          const res = await fetch(
            apiUrl(`/api/auth/signup-availability?email=${encodeURIComponent(trimmed)}`),
          );
          if (cancelled) return;
          if (!res.ok) {
            // On any failure (network, 5xx, 429), don't block the user —
            // surface "off" so the Request-access path stays reachable,
            // which is the safe default when availability is unknown.
            setState({ mode: "off", allowed: false, loading: false });
            return;
          }
          const data = (await res.json()) as {
            mode?: SignupMode;
            allowed?: boolean;
          };
          if (cancelled) return;
          setState({
            mode: (data.mode ?? "off") as SignupMode,
            allowed: Boolean(data.allowed),
            loading: false,
          });
        } catch {
          if (!cancelled) {
            setState({ mode: "off", allowed: false, loading: false });
          }
        }
      })();
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [email]);

  return state;
}
