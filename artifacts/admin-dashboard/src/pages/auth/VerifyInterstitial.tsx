import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";

/**
 * TEN-012 Task 10: "Check your inbox" verification interstitial.
 *
 * Shown in two places:
 *  1. SignUpForm.tsx, immediately after a successful email `signUp` that left
 *     the user WITHOUT a session (GoTrue returned a `user` but `null`
 *     session — it expects the inbox confirmation link to be clicked first).
 *  2. App.tsx AuthGate, as a guard for ANY signed-in session whose email is
 *     not yet confirmed (`session.user.email_confirmed_at` is null). A user
 *     in that state must see ONLY the interstitial — never the app shell and
 *     never the org-role gate. Google-OAuth sessions arrive already
 *     email-confirmed (Supabase sets the timestamp from the verified Google
 *     email), so they skip this branch and proceed to the role/facility gates.
 *
 * The backend `requireVerifiedEmail` gate (Task 6) is the real security
 * boundary; this UI just directs the user to finish confirming. Kept minimal
 * per YAGNI — resend + change-email only (no countdown, no inbox polling).
 */

export interface VerifyInterstitialProps {
  /** Email the verification link was sent to. */
  email: string;
  /** Returns the user to the email-entry form (e.g. to fix a typo). Omit to
   * hide the "Use a different email" action — e.g. when rendered from the
   * AuthGate for a session that already exists and can't "go back" to a form. */
  onChangeEmail?: () => void;
}

export function VerifyInterstitial({ email, onChangeEmail }: VerifyInterstitialProps) {
  // Inline status only (NOT a toast): resend is a one-shot action whose
  // result belongs next to the button the user just pressed, matching the
  // field-error convention already used in SignUpForm.
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const resend = async () => {
    setStatus("sending");
    setStatusMessage(null);
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) {
      setStatus("error");
      setStatusMessage(error.message);
      return;
    }
    setStatus("sent");
    setStatusMessage("Verification link sent. Check your inbox again.");
  };

  return (
    <div className="w-full max-w-sm space-y-4 rounded-md border border-border p-6 text-center">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Check your inbox</h1>
        <p className="text-sm text-muted-foreground">
          We sent a verification link to{" "}
          <span className="font-medium text-foreground">{email}</span>. Click it to
          activate your account.
        </p>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          className="w-full"
          onClick={resend}
          disabled={status === "sending"}
        >
          {status === "sending" ? "Sending…" : "Resend verification link"}
        </Button>
        {status === "sent" && statusMessage && (
          <p className="text-sm text-muted-foreground">{statusMessage}</p>
        )}
        {status === "error" && statusMessage && (
          <p className="text-sm text-destructive">{statusMessage}</p>
        )}
      </div>

      {onChangeEmail && (
        <Button variant="link" className="text-sm" onClick={onChangeEmail}>
          Use a different email
        </Button>
      )}
    </div>
  );
}
