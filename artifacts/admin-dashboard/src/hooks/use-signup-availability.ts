import { useEffect, useState } from "react";
import { getSignupAvailability } from "@workspace/api-client-react";

/**
 * TEN-012 Task 12: debounced probe of `GET /auth/signup-availability`.
 *
 * The AuthGate's "Create an account" path needs to know, given the email the
 * user just typed, whether sign-up is open / allowlisted / closed so it can
 * render Create-account vs. a Request-access placeholder (Task 11). The
 * endpoint is PUBLIC (mounted above the requireSignedIn gate in api-server's
 * app.ts), so this hook hits it through the generated fetcher with NO bearer
 * token (the endpoint ignores the Authorization header when one is present).
 *
 * The generated `getSignupAvailability` fetcher uses the same `customFetch`
 * every other dashboard request uses, so the API base URL resolves
 * identically: App.tsx calls `setBaseUrl(VITE_API_BASE_URL)` once at boot,
 * and the generated client prepends it (custom-fetch.ts `applyBaseUrl`) to
 * the `/api/auth/signup-availability` path the spec emits. No hand-rolled
 * URL builder is needed here anymore.
 *
 * We use the generated FETCHER (not the `useGetSignupAvailability` hook)
 * because the debounce + fail-safe-to-"off"-on-error contract is bespoke:
 * react-query's own retry/refetch semantics would fight the "when in doubt,
 * show the waitlist path" default. The fetcher throws on any non-2xx (or on
 * a network failure), and our catch arm maps every throw to the safe "off"
 * state below — never blocking the user from requesting access.
 */
export type SignupMode = "off" | "allowlist" | "public";

export interface SignupAvailability {
  mode: SignupMode | null;
  allowed: boolean;
  loading: boolean;
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
          const data = await getSignupAvailability({ email: trimmed });
          if (cancelled) return;
          setState({
            mode: (data.mode ?? "off") as SignupMode,
            allowed: Boolean(data.allowed),
            loading: false,
          });
        } catch {
          if (!cancelled) {
            // On any failure (network, 5xx, 429, 4xx), don't block the user —
            // surface "off" so the Request-access path stays reachable,
            // which is the safe default when availability is unknown.
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
