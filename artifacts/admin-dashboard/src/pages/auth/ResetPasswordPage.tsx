import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingScreen } from "@/pages/auth/LoadingScreen";

/**
 * AUTH-002 Task 3: Set-new-password flow, states 3 & 3B.
 *
 * This route is the landing target of a recovery email link (the
 * `redirectTo` built by ForgotPasswordPanel). When the user clicks that link,
 * Supabase's PKCE flow exchanges the recovery code for a short-lived
 * "recovery" session and fires an `PASSWORD_RECOVERY` auth-state event. We
 * detect that to render state 3 (the set-password form). If no recovery
 * session is established within a short window — a stale/already-consumed
 * code, an expired link, or the user navigated here directly without a
 * recovery token — we render state 3B ("This reset link has expired.") with a
 * "Send a new link" button that routes back to the sign-in screen's forgot
 * panel via the home route.
 *
 * On a successful `updateUser({ password })`, redirect to `/` — the recovery
 * session is now a normal session, so AuthGate lets the user straight through
 * to the dashboard.
 *
 * Token inspection: we lean on `supabase.auth.getSession()` plus
 * `onAuthStateChange` rather than hand-parsing the URL, because PKCE recovery
 * exchanges happen asynchronously on the client. `getSession()` covers the
 * race where the exchange already completed before mount, and the listener
 * covers the case where it completes just after.
 */

type ResetState = "checking" | "valid" | "expired";

const MIN_PASSWORD_LENGTH = 8;

function passwordError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const [resetState, setResetState] = useState<ResetState>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const resolveValid = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      setResetState("valid");
    };
    const resolveExpired = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      setResetState("expired");
    };

    // If the PKCE recovery exchange already landed a session before this
    // component mounted, getSession() resolves with it immediately.
    supabase.auth.getSession().then(({ data }) => {
      // A recovery flow always establishes a session (the recovery user is
      // signed in for the duration of the password reset). No session => the
      // code was missing/invalid/expired.
      if (data.session) resolveValid();
    });

    // PASSWORD_RECOVERY fires once the (possibly still-pending) PKCE exchange
    // completes. covers the race where getSession() ran before the exchange.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) resolveValid();
    });

    // If neither fires within a short window, the link is unusable — fall
    // through to state 3B. Generous enough to cover a slow PKCE exchange.
    timeout = setTimeout(resolveExpired, 3000);

    return () => {
      if (timeout) clearTimeout(timeout);
      listener.subscription.unsubscribe();
    };
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const policyError = passwordError(password);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    // updateUser on a recovery session upgrades it to a normal session, so
    // AuthGate at `/` lets the user straight into the dashboard.
    navigate("/");
  };

  if (resetState === "checking") {
    return <LoadingScreen />;
  }

  if (resetState === "expired") {
    // State 3B: the recovery token is missing/invalid/expired. Route back to
    // the home screen — AuthGate's sign-in view exposes the "Forgot
    // password?" link to start a fresh flow.
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background text-center px-4">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
        <p className="text-sm text-destructive max-w-sm">
          This reset link has expired.
        </p>
        <Button className="w-full max-w-sm" onClick={() => navigate("/")}>
          Send a new link
        </Button>
      </div>
    );
  }

  // State 3: valid recovery session — collect the new password.
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </div>
  );
}
