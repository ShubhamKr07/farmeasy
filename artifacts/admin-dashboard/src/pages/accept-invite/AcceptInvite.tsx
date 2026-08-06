import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useAcceptInvitation } from "@workspace/api-client-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Multi-tenant team-invitation accept page (TEN-010 Task 13). Reached from an
 * invitation email; the invite token travels in the URL FRAGMENT (never the
 * query string), so it never hits a server log as a request parameter. This
 * route is mounted OUTSIDE AuthGate in App.tsx — invitees have no Supabase
 * session yet, so AuthGate's `!session` sign-in screen must not gate it.
 *
 * The invite carries the email server-side, so the form is password-only:
 * `POST /invitations/accept` creates the org membership, and the response's
 * `email` drives the follow-up Supabase `signInWithPassword`. Technicians are
 * mobile-app-only, so they get a directing screen instead of the dashboard.
 */
type AcceptStatus = "form" | "technician-directing";

/**
 * Duck-types a mutation error's `status`/`data` fields into a user-facing
 * inline message for the accept form. `ApiError` (thrown by custom-fetch on
 * any non-2xx) carries `status: number` and `data` (the parsed body), but
 * that class is NOT re-exported from `@workspace/api-client-react`'s public
 * index — so read the shape directly rather than importing a type, exactly
 * as `TeamSection.tsx`'s `describeInviteError` does for the create-invite
 * 400/403 cases. Covers the documented `POST /invitations/accept` 400
 * (invalid/expired/used token, or invitee already in an org).
 */
function describeAcceptError(err: unknown): { message: string; hint?: string } {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status: unknown }).status
      : undefined;
  const body =
    typeof err === "object" && err !== null && "data" in err
      ? (err as { data: unknown }).data
      : undefined;
  const apiMessage =
    body && typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : undefined;

  if (status === 400) {
    // The server's 400 (e.g. "invitation already used", "token expired",
    // "you already belong to an organization") is specific and actionable —
    // surface it verbatim; fall back to a generic 400 hint only if the body
    // was empty. A "request a new invitation" hint is always appended so the
    // invitee knows what to do next regardless of the exact server message.
    return {
      message:
        apiMessage ?? "This invitation link is invalid or has expired.",
      hint: "Please ask your admin to send a new invitation.",
    };
  }
  return { message: "Couldn't accept the invitation. Please try again." };
}

export function AcceptInvite() {
  // Read the token from the URL fragment (`#token=...`), never the query
  // string. Fragment params never reach the server as a request line, keeping
  // the one-time token out of server/proxy access logs.
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");

  const acceptInvitation = useAcceptInvitation();
  const [, navigate] = useLocation();

  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [status, setStatus] = useState<AcceptStatus>("form");

  // No token (missing/empty fragment) — there's nothing to accept. Render the
  // same centered chrome as the form, minus the form itself.
  if (!token) {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background text-center px-4">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
        <p className="text-muted-foreground max-w-sm">
          This invitation link is invalid or incomplete. Please ask your admin
          to send a new invitation.
        </p>
      </div>
    );
  }

  // Technicians are mobile-app-only — once their account is ready, direct
  // them to the app rather than the web dashboard (which the role gate would
  // deny anyway).
  if (status === "technician-directing") {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background text-center px-4">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
        <p className="text-muted-foreground max-w-sm">
          Your account is ready — open the FarmSmart mobile app to get started.
        </p>
      </div>
    );
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    setErrorHint(null);
    acceptInvitation.mutate(
      { data: { token, password } },
      {
        // The invite carries the email server-side; the accept response echoes
        // it back so we can sign the (now-provisioned) user in without an
        // email field on the form.
        onSuccess: async (res) => {
          const { error: signInError } = await supabase.auth.signInWithPassword({
            email: res.email,
            password,
          });
          if (signInError) {
            setSubmitError(signInError.message);
            return;
          }
          if (res.role === "technician") {
            setStatus("technician-directing");
          } else {
            navigate("/");
          }
        },
        onError: (err) => {
          const { message, hint } = describeAcceptError(err);
          setSubmitError(message);
          setErrorHint(hint ?? null);
        },
      },
    );
  };

  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {submitError && (
          <div className="space-y-1">
            <p className="text-sm text-destructive">{submitError}</p>
            {errorHint && <p className="text-sm text-destructive">{errorHint}</p>}
          </div>
        )}
        <Button type="submit" className="w-full" disabled={acceptInvitation.isPending}>
          Set password &amp; join
        </Button>
      </form>
    </div>
  );
}
