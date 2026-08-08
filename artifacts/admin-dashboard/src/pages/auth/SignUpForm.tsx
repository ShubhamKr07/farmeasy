import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SignupMode } from "@/hooks/use-signup-availability";
import { VerifyInterstitial } from "@/pages/auth/VerifyInterstitial";

/**
 * TEN-012 Task 9: Create-account form for the AuthGate's `!session` view.
 *
 * The parent AuthGate renders this ONLY when sign-up is open (mode `public`,
 * or `allowlist` with the entered email allowlisted). When sign-up is closed
 * (`mode === "off"`) or the allowlist rejects the email
 * (`mode === "allowlist"` + `!allowed`), the parent renders the
 * Request-access placeholder instead — App.tsx makes that routing decision.
 *
 * Inline password-policy validation: mirrors Supabase/GoTrue's own minimum
 * (8 chars). The error renders as field text under the input — NEVER a toast
 * — because (a) it's a per-keystroke field state, not a one-shot action
 * result, and (b) toasts here would clash with the global Toaster's role of
 * surfacing server-side action outcomes. The submit is blocked client-side
 * while the policy fails, so the user never sees Supabase's own
 * "Password should be at least 8 characters" rejection.
 *
 * On a successful email `signUp`, transitions to the VerifyInterstitial
 * (Task 10): the full "check your inbox" view with resend + change-email.
 */

export interface SignUpFormProps {
  /** Availability for the email the user typed — drives the Request-access
   * placeholder branch when sign-up is closed / the email isn't allowlisted. */
  mode: SignupMode | null;
  allowed: boolean;
  /** Controlled email input shared with the parent AuthGate so the
   * availability probe runs against the same field. */
  email: string;
  onEmailChange: (email: string) => void;
}

const MIN_PASSWORD_LENGTH = 8;

function passwordError(password: string): string | null {
  if (password.length === 0) return null; // empty = not-yet-touched, no error
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function SignUpForm({ mode, allowed, email, onEmailChange }: SignUpFormProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(
    null,
  );

  // Task 11 fills this in — App.tsx decides to render SignUpForm only when
  // sign-up is open, but guard against the parent mis-routing here too: if
  // the email's availability is closed/forbidden, show the request-access
  // placeholder instead of the form. Keeps SignUpForm self-defensive.
  if (mode === "off" || (mode === "allowlist" && !allowed)) {
    return (
      <div className="w-full max-w-sm space-y-3 rounded-md border border-dashed border-border p-4 text-center">
        <p className="text-sm text-muted-foreground">
          Sign-up is currently by request. We'll review your account.
        </p>
        {/* TODO(TEN-012 T11): RequestAccessForm */}
      </div>
    );
  }

  // Successful email signUp: GoTrue returned a user but no session, so the
  // user must confirm via the inbox link. Show the full VerifyInterstitial
  // (resend + change-email). onChangeEmail resets the interstitial state so
  // the form re-renders below; the email field value itself stays in the
  // parent-controlled `email` prop, so the user can edit the address there.
  if (pendingVerificationEmail) {
    return (
      <VerifyInterstitial
        email={pendingVerificationEmail}
        onChangeEmail={() => setPendingVerificationEmail(null)}
      />
    );
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    // Re-validate inline before the network call so a paste-and-submit of a
    // short password still shows the field error instead of going to Supabase.
    const policyError = passwordError(password);
    if (policyError) {
      setError(policyError);
      return;
    }

    setBusy(true);
    const trimmedEmail = email.trim();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
    });
    setBusy(false);

    if (signUpError) {
      // Surface the server message inline (NOT a toast) so the user sees it
      // in the same place as the client-side policy error.
      setError(signUpError.message);
      return;
    }

    // Email confirmation required: GoTrue returns a user without a session
    // and expects the inbox link. OAuth sign-ups (Google) bypass this branch
    // entirely — they redirect away from the page before signUp() resolves.
    if (data.user && !data.session) {
      setPendingVerificationEmail(trimmedEmail);
      return;
    }

    // Edge case: an autoconfirmed instance returns a live session directly
    // (no inbox step). The AuthGate re-renders to the signed-in branch the
    // moment useSupabaseSession sees the new session, so nothing extra to do.
  };

  return (
    <>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signup-password">Password</Label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              // Clear a stale inline error as soon as the input is valid again.
              if (error) setError(null);
            }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Create account
        </Button>
      </form>
      <div className="flex items-center gap-3 w-full max-w-sm">
        <div className="h-px bg-border flex-1" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="h-px bg-border flex-1" />
      </div>
      <Button
        variant="outline"
        className="w-full max-w-sm"
        onClick={() => supabase.auth.signInWithOAuth({ provider: "google" })}
      >
        Continue with Google
      </Button>
    </>
  );
}
