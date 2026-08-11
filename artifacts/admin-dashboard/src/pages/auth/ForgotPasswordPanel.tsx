import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail } from "lucide-react";

/**
 * AUTH-002 Task 3: Forgot-password flow, states 1 & 2.
 *
 * Rendered INSIDE the AuthGate sign-in screen (not its own route) — the
 * "Forgot password?" link under the password field flips AuthGate's
 * `authView` to `"forgot"`, which renders this panel in place of the sign-in
 * form. State is internal: "form" (email entry) -> "confirmation" (neutral
 * envelope screen).
 *
 * SECURITY (no account-existence oracle): the confirmation screen's copy —
 * "If an account exists for this email, a reset link is on its way." — is
 * rendered IDENTICALLY whether `resetPasswordForEmail` succeeded for a
 * registered address, succeeded for an unregistered address (Supabase does
 * NOT error on unknown emails by default), or even errored. We deliberately
 * swallow the resolved value and any error so the UI can't be probed to
 * distinguish "exists" from "doesn't exist". See ForgotPasswordPanel.test.tsx
 * for the assertion that guards this.
 *
 * `redirectTo` builds the post-email-click landing URL against the same base
 * path the app is served from (Vite `BASE_URL`, already used by WouterRouter
 * in App.tsx), pointing at the `/reset-password` route handled by
 * ResetPasswordPage.
 */

type ForgotState = "form" | "confirmation";

export interface ForgotPasswordPanelProps {
  /** Returns to the sign-in form (state 1 of this panel's sibling). */
  onBackToSignIn: () => void;
}

function buildResetRedirectUrl(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/reset-password`;
}

export function ForgotPasswordPanel({ onBackToSignIn }: ForgotPasswordPanelProps) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<ForgotState>("form");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    // Result is intentionally ignored — see the file-level security note. We
    // transition to the neutral confirmation screen for success AND error so
    // the panel never leaks whether the email is registered. (GoTrue's
    // default config does not error on unknown emails anyway, but not every
    // deployment guarantees that, so we harden against both cases here.)
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: buildResetRedirectUrl(),
    });
    setBusy(false);
    setState("confirmation");
  };

  if (state === "confirmation") {
    return (
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="flex justify-center">
          <Mail className="h-10 w-10 text-muted-foreground" aria-hidden />
        </div>
        <p className="text-sm text-muted-foreground">
          If an account exists for this email, a reset link is on its way.
        </p>
        <Button variant="link" className="text-sm" onClick={onBackToSignIn}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <div className="space-y-2">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <Button variant="link" className="text-sm w-full" onClick={onBackToSignIn}>
        Back to sign in
      </Button>
    </form>
  );
}
