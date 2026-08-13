import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { setBaseUrl, setAuthTokenGetter, usePostAuthEvent } from "@workspace/api-client-react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Smartphone } from "lucide-react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useOrgRole, type OrgRole } from "@/hooks/use-org-role";
import { useSignupAvailability } from "@/hooks/use-signup-availability";
import { SignUpForm } from "@/pages/auth/SignUpForm";
import { VerifyInterstitial } from "@/pages/auth/VerifyInterstitial";
import { ForgotPasswordPanel } from "@/pages/auth/ForgotPasswordPanel";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
// Re-exported so existing `import { LoadingScreen } from "@/App"` (if any) and
// the local references below keep resolving after the extraction to its own
// module. The implementation now lives in pages/auth/LoadingScreen.tsx so
// ResetPasswordPage can reuse it without a circular dep on App.tsx.
import { LoadingScreen } from "@/pages/auth/LoadingScreen";
import { ActiveFacilityProvider, useActiveFacility } from "@/hooks/use-active-facility";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/not-found";

import { AppLayout } from "@/components/layout/AppLayout";
import { Overview } from "@/pages/overview/Overview";
import { Cycles } from "@/pages/cycles/Cycles";
import { Inventory } from "@/pages/inventory/Inventory";
import { Shipments } from "@/pages/shipments/Shipments";
import { Accounting } from "@/pages/accounting/Accounting";
import { Layout } from "@/pages/layout/Layout";
import { OrgOverview } from "@/pages/org-overview/OrgOverview";
import { Profile } from "@/pages/profile/Profile";
import { Settings } from "@/pages/settings/Settings";
import { Wizard } from "@/pages/onboarding/Wizard";
import { AcceptInvite } from "@/pages/accept-invite/AcceptInvite";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
if (apiBaseUrl) setBaseUrl(apiBaseUrl);

const queryClient = new QueryClient();

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/cycles" component={Cycles} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/shipments" component={Shipments} />
        <Route path="/accounting" component={Accounting} />
        <Route path="/layout" component={Layout} />
        <Route path="/org" component={OrgOverview} />
        <Route path="/profile" component={Profile} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

/**
 * Wires the Supabase Auth session token into the shared API client so every
 * request carries `Authorization: Bearer <token>`. The server validates it.
 */
function SupabaseAuthBridge() {
  useEffect(() => {
    setAuthTokenGetter(async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    });
  }, []);
  return null;
}

/**
 * AUTH-003 Task 4 — the redesigned sign-in panel. A SINGLE component that
 * renders 5 visual states via conditional JSX (never separate routes/modals):
 *
 *   - default       : email + password form, Google button, footer link
 *   - error         : default + reserved error slot populated above the form
 *   - busy          : default with "Signing in…" + spinner, inputs disabled
 *   - oauth         : form inputs hidden (not removed) + "Redirecting to Google…"
 *   - technician    : phone-icon denied screen overlaid on the SAME card
 *
 * GEOMETRY CONTRACT — all 5 states share an IDENTICAL panel bounding box:
 *   1. The card width is fixed (`max-w-sm`) and its height is pinned to a
 *      fixed value (`h-[560px]`), so the box never grows or shrinks as
 *      content changes between states.
 *   2. The error region is ALWAYS rendered at a reserved fixed height, so
 *      populating it in the error state can never push the fields down.
 *   3. The "oauth" and "technician" states keep the form mounted in the DOM
 *      and visually hidden (`aria-hidden` + opacity-0), then render their own
 *      content absolutely-positioned over the same region. Removing the form
 *      would shrink the box and break the "no layout shift" requirement —
 *      see SignInPanel.test.tsx for the dimension-identity assertions.
 *
 * The parent AuthGate owns the email value (shared with the signup
 * availability probe + the SignUpForm) and the view switch (signin/signup/
 * forgot); this panel only renders when view === "signin". It receives the
 * resolved org `role` so the technician-denied state is triggered by the SAME
 * condition that previously routed to a separate TechnicianDeniedScreen.
 */
interface SignInPanelProps {
  email: string;
  onEmailChange: (email: string) => void;
  /** Switches the AuthGate to the forgot-password / signup panels. */
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  role: OrgRole | null;
  /** Whether the "New here? Create an account" link should be offered
   * (gated by sign-up availability in the parent). */
  showCreateAccount: boolean;
}

export function SignInPanel({
  email,
  onEmailChange,
  onForgotPassword,
  onCreateAccount,
  role,
  showCreateAccount,
}: SignInPanelProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oauthRedirecting, setOauthRedirecting] = useState(false);
  // AUTH-004: sign-in funnel telemetry. signin_success fires once a session
  // is established; signin_failed (with the error reason) fires on rejection.
  const postAuthEvent = usePostAuthEvent();

  // Technician-denied is driven by the SAME condition that used to route to
  // the standalone TechnicianDeniedScreen: useOrgRole resolves "technician".
  // Here it just flips the panel's state instead of unmounting the form.
  const technicianDenied = role === "technician";

  // Derive the active panel state from the flags above. "technician" wins
  // (a signed-in technician should never see the busy/redirect states), then
  // "oauth", then "busy", then "error" if a message is set, else "default".
  const panelState: PanelState = technicianDenied
    ? "technician"
    : oauthRedirecting
      ? "oauth"
      : busy
        ? "busy"
        : error
          ? "error"
          : "default";

  const signIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setBusy(false);
    // Keep the existing error-message extraction pattern but normalize the
    // copy to the spec'd inline message (AUTH-003 Task 4 mockup 2b). The
    // network-level error message is the trigger; we surface a consistent
    // user-facing string.
    if (signInError) {
      setError("Wrong email or password.");
      // AUTH-004: record the failed sign-in attempt (reason is the GoTrue
      // message — no PII beyond the userId the server derives from the JWT).
      void postAuthEvent.mutateAsync({
        data: { eventType: "signin_failed", reason: signInError.message },
      });
    } else {
      // AUTH-004: session established — record the funnel's success step.
      void postAuthEvent.mutateAsync({ data: { eventType: "signin_success" } });
    }
  };

  // OAuth-redirect: flip the state BEFORE firing the redirect so the panel
  // shows the spinner + "Redirecting to Google…" while the browser navigates
  // away. The inputs stay mounted (hidden) so the panel geometry is stable.
  const continueWithGoogle = () => {
    setOauthRedirecting(true);
    void supabase.auth.signInWithOAuth({ provider: "google" });
  };

  // "Sign in as someone else" on the technician panel: clear the Supabase
  // session (which clears the role claim via onAuthStateChange) and reset
  // the panel back to the default sign-in form. The form was never removed,
  // so there's no remount/flash.
  const signInAsSomeoneElse = async () => {
    await supabase.auth.signOut();
    setError(null);
    setBusy(false);
    setOauthRedirecting(false);
  };

  // Inputs are disabled during busy + oauth. The technician state hides the
  // form entirely (overlay), so disabling is moot there.
  const inputsDisabled = busy || oauthRedirecting;
  // When an overlay (oauth / technician) is shown, the default form + footer
  // are visually hidden but kept mounted to preserve the box footprint.
  const overlayActive = oauthRedirecting || technicianDenied;

  return (
    <div
      data-testid="signin-panel"
      data-panel-state={panelState}
      className="relative w-full max-w-sm h-[560px] rounded-2xl bg-card text-card-foreground p-8 flex flex-col"
    >
      {/* Reserved error slot — ALWAYS rendered at a fixed height so populating
          it in the error state can never push the fields down. Empty state is
          invisible but still occupies the same vertical space. */}
      <div className="h-6 flex items-center" data-testid="error-slot">
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid="inline-error">
            {error}
          </p>
        )}
      </div>

      {/* Heading block — present in every state, anchored to the top so the
          region below it never drifts. */}
      <div className="space-y-1 mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Sign in to FarmSmart
        </h1>
        <p className="text-sm text-muted-foreground">
          The operations dashboard for your indoor farm.
        </p>
      </div>

      {/* Form region — a relative container so the oauth/technician overlays
          can absolutely fill exactly this area without covering the heading
          or error slot. The form is KEPT MOUNTED in every state. */}
      <div className="relative flex-1" data-testid="form-region">
        <form
          onSubmit={signIn}
          aria-hidden={overlayActive}
          className={cn(
            "flex flex-col gap-4 transition-opacity",
            overlayActive
              ? "opacity-0 pointer-events-none absolute inset-0"
              : "opacity-100",
          )}
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              disabled={inputsDisabled}
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={inputsDisabled}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button
            variant="link"
            type="button"
            className="self-start h-auto p-0 text-sm -mt-1"
            disabled={inputsDisabled}
            onClick={onForgotPassword}
          >
            Forgot password?
          </Button>
          <Button
            type="submit"
            className="w-full"
            disabled={inputsDisabled}
            data-testid="signin-button"
          >
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>

        {/* OAuth-redirect overlay — spinner + "Redirecting to Google…", fills
            the form region so the card keeps its footprint. Inputs are hidden
            behind it (mounted, not removed). */}
        {oauthRedirecting && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
            data-testid="oauth-overlay"
          >
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">Redirecting to Google…</p>
          </div>
        )}

        {/* Technician-denied overlay — phone icon, heading, copy, two CTAs and
            a "Sign in as someone else" link. Same form region, same card. */}
        {technicianDenied && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center"
            data-testid="technician-overlay"
          >
            <Smartphone className="h-10 w-10 text-muted-foreground" aria-hidden />
            <h2 className="text-lg font-semibold text-foreground">
              The dashboard is for admins
            </h2>
            <p className="text-sm text-muted-foreground max-w-[18rem]">
              Open the FarmSmart mobile app to do your work.
            </p>
            <Button className="w-full" asChild>
              <a
                href="https://farmsmart.app/get-the-app"
                target="_blank"
                rel="noopener noreferrer"
              >
                Get the app
              </a>
            </Button>
            <Button variant="outline" className="w-full" asChild>
              <a href="farmsmart://open" rel="noopener noreferrer">
                Open in app
              </a>
            </Button>
            <Button
              variant="link"
              className="text-sm h-auto p-0"
              onClick={signInAsSomeoneElse}
            >
              Sign in as someone else
            </Button>
          </div>
        )}
      </div>

      {/* Footer region — divider + Google button + create-account link. Kept
          OUTSIDE the overlay region and hidden (but reserved) when an overlay
          is active so the box footprint is unchanged. */}
      <div className={cn("flex flex-col gap-4 mt-6", overlayActive && "invisible")}>
        <div className="flex items-center gap-3">
          <div className="h-px bg-border flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px bg-border flex-1" />
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={continueWithGoogle}
          disabled={inputsDisabled}
        >
          Continue with Google
        </Button>
        {showCreateAccount && (
          <p className="text-sm text-muted-foreground text-center">
            New here?{" "}
            <Button
              variant="link"
              type="button"
              className="h-auto p-0 text-sm"
              onClick={onCreateAccount}
            >
              Create an account
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}

/** The 5 visual states the SignInPanel renders — see the component doc. */
type PanelState = "default" | "error" | "busy" | "oauth" | "technician";

/**
 * Shows a Supabase-backed sign-in screen until the user is authenticated.
 * Mirrors the previous Clerk gate structure, swapping `<SignIn />` for an
 * email/password form plus a Google OAuth button. TEN-012 Task 9 adds a
 * "Create an account" toggle that switches to SignUpForm (availability-gated
 * via useSignupAvailability, which probes the same email field). AUTH-002
 * Task 3 adds the forgot-password panel. AUTH-003 Task 4 redesigns the
 * sign-in form itself into a 5-state panel (SignInPanel above).
 */
function AuthGate() {
  const { session, loading } = useSupabaseSession();
  const { role, loading: roleLoading } = useOrgRole();
  const [email, setEmail] = useState("");
  // TEN-012 Task 9: toggle between the existing sign-in form (unchanged) and
  // the new Create-account form. Defaults to sign-in so existing behavior is
  // preserved for every user who never touches the toggle. AUTH-002 Task 3
  // adds a third value, "forgot", which swaps the sign-in form for the
  // ForgotPasswordPanel (states 1-2) reached via the "Forgot password?" link.
  const [view, setView] = useState<"signin" | "signup" | "forgot">("signin");

  // Probe sign-up availability for the email typed into the SHARED email
  // field, so a user who typed their address to sign in already knows (once
  // they flip to "Create an account") whether sign-up is open / allowlisted /
  // closed. The probe is public (no bearer token) — see useSignupAvailability.
  const { mode, allowed } = useSignupAvailability(email);

  if (loading) {
    return <LoadingScreen />;
  }

  if (!session) {
    // Offer the "Create an account" toggle whenever a sign-up path exists for
    // the typed email: open sign-up (public), an allowlisted email, OR
    // sign-up closed (off) — in the last case the toggle still routes to the
    // Request-access placeholder inside SignUpForm. mode === null (no email
    // typed / probe in flight) defaults to showing the toggle so a brand-new
    // visitor can reach Create-account immediately. An email confirmed NOT
    // allowlisted (allowlist && !allowed) hides the toggle in the sign-in
    // view. Force-show whenever we're already in the sign-up view so the user
    // can always switch back to sign-in.
    const showCreateAccountToggle =
      // Hide the create-account toggle entirely in the forgot-password view —
      // that panel has its own "Back to sign in" action and shouldn't offer a
      // detour into sign-up.
      view !== "forgot" &&
      (view === "signup" ||
        mode === null ||
        mode === "public" ||
        mode === "off" ||
        (mode === "allowlist" && allowed));

    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-[#1a2e23]">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
        {/* Tagline + sub-line above the panel (Mockup 2a). The tagline uses a
            light-on-dark palette (white on #1a2e23 ≈ 14.4:1, well above WCAG
            AA 4.5:1) so the lockup reads cleanly against the dark backdrop. */}
        <div className="w-full max-w-sm text-center space-y-1">
          <p className="text-base font-medium text-white">
            Everything between the seed and the sale.
          </p>
          <p className="text-sm text-[#c7d4cc]">
            The operations dashboard for your indoor farm.
          </p>
        </div>
        {view === "signup" ? (
          <SignUpForm
            mode={mode}
            allowed={allowed}
            email={email}
            onEmailChange={setEmail}
          />
        ) : view === "forgot" ? (
          // AUTH-002 Task 3: forgot-password panel (states 1-2). Rendered on
          // the same auth screen via state — not a separate route — so it
          // reuses the logo + centered chrome above. "Back to sign in"
          // returns to the sign-in form.
          <ForgotPasswordPanel onBackToSignIn={() => setView("signin")} />
        ) : (
          <SignInPanel
            email={email}
            onEmailChange={setEmail}
            onForgotPassword={() => setView("forgot")}
            onCreateAccount={() => setView("signup")}
            role={role}
            showCreateAccount={showCreateAccountToggle}
          />
        )}

        {/* Keep the create-account toggle reachable from the signup/forgot
            views too (matching pre-redesign behavior) so a user can always
            flip back to sign-in. */}
        {showCreateAccountToggle && view !== "signin" && (
          <Button
            variant="link"
            className="text-sm text-[#c7d4cc] hover:text-white"
            onClick={() => setView("signin")}
          >
            Already have an account? Sign in
          </Button>
        )}
      </div>
    );
  }

  // Email-verification guard (TEN-012 T10): a signed-up-but-unverified
  // session must see ONLY the interstitial — never the app shell and never
  // the org-role gate below. `email_confirmed_at` stays null until the user
  // clicks the inbox link; Google-OAuth sessions arrive already confirmed
  // (Supabase stamps the timestamp from the verified Google email), so they
  // skip this branch and proceed to the role/facility gates. The backend
  // `requireVerifiedEmail` gate (Task 6) is the real security boundary;
  // this is the directing UX. No onChangeEmail here — a session already
  // exists, so there's no "form to go back to"; the user resends or
  // confirms out-of-band.
  if (session && !session.user.email_confirmed_at) {
    return <VerifyInterstitial email={session.user.email ?? ""} />;
  }

  // Org-role gate (AUTH-003): once a session exists, block the app shell until
  // the role claim resolves. A technician is now directed back to the
  // SignInPanel itself — which renders the technician-denied state (state 5)
  // on the same card — instead of a separate TechnicianDeniedScreen, so the
  // denied UX is geometrically consistent with the sign-in flow. `useOrgRole`
  // is called unconditionally above; these values are simply unused in the
  // earlier `loading` / `!session` early-return branches.
  if (roleLoading) {
    return <LoadingScreen />;
  }

  if (role === "technician") {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-[#1a2e23]">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
        <SignInPanel
          email={email}
          onEmailChange={setEmail}
          onForgotPassword={() => setView("forgot")}
          onCreateAccount={() => setView("signup")}
          role={role}
          showCreateAccount={false}
        />
      </div>
    );
  }

  return (
    <ActiveFacilityProvider>
      <FacilityGate />
    </ActiveFacilityProvider>
  );
}

/**
 * Facility-picker screen — shown only when an org has 2+ facilities and no
 * valid persisted selection exists yet (fresh browser, or the persisted id
 * no longer belongs to this org). Never shown for single-facility orgs
 * (useActiveFacility auto-selects those silently).
 */
function FacilityPicker({
  facilities,
  onSelect,
}: {
  facilities: { id: number; facilityName: string }[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[43px] w-auto" />
      <p className="text-muted-foreground">Choose a facility to continue</p>
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {facilities.map((f) => (
          <Button key={f.id} variant="outline" onClick={() => onSelect(f.id)} data-testid={`picker-facility-${f.id}`}>
            {f.facilityName}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Wizard-completion guard (WIZ-001), now per-facility (TEN-008): a facility
 * whose wizard_progress row isn't "done" yet routes into the wizard for
 * THAT facility, instead of any dashboard content. "Add facility" starts a
 * brand-new wizard run (facilityId not yet known) via isAddingFacility,
 * distinct from re-entering an existing facility's unfinished wizard.
 *
 * needsPicker (2+ facilities, no valid persisted selection) blocks on an
 * explicit choice rather than guessing — see useActiveFacility's own doc
 * comment for the full 0/1/2+-facility resolution rule.
 */
function FacilityGate() {
  const {
    activeFacilityId,
    needsPicker,
    facilities,
    isLoading,
    selectFacility,
    isAddingFacility,
    finishAddFacility,
  } = useActiveFacility();

  // Guard against a flash of the wizard/picker while useListFacilities is
  // still in flight: facilities defaults to [] during loading, which would
  // otherwise look identical to "brand-new user, no facility yet" below.
  if (isLoading) return <LoadingScreen />;

  if (needsPicker) {
    return <FacilityPicker facilities={facilities} onSelect={selectFacility} />;
  }

  if (isAddingFacility) {
    return <Wizard facilityId={null} onFacilityCreated={finishAddFacility} />;
  }

  const activeFacility = facilities.find((f) => f.id === activeFacilityId);
  if (activeFacility && !activeFacility.onboarded) {
    return <Wizard facilityId={activeFacility.id} onFacilityCreated={() => undefined} />;
  }
  if (!activeFacility && facilities.length === 0) {
    // Brand-new user, no facility at all yet — first-time onboarding.
    return <Wizard facilityId={null} onFacilityCreated={finishAddFacility} />;
  }

  return <Router />; // existing dashboard routes
}

/**
 * Completes the Supabase PKCE OAuth flow. After Google redirects back with a
 * `?code=...` query param, exchange it for a session explicitly (the client is
 * configured with `detectSessionInUrl: false`). Strips the code from the URL
 * afterward so a reload doesn't attempt a second (already-consumed) exchange.
 */
function OAuthCallbackHandler() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;
    void (async () => {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[OAuth] code exchange failed:", error.message);
      }
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    })();
  }, []);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <SupabaseAuthBridge />
          <OAuthCallbackHandler />
          <Switch>
            {/* Invitees have no session yet — /accept-invite must bypass the
                AuthGate sign-in screen. Keep the auth bridge + OAuth handler
                above mounted for all paths. */}
            <Route path="/accept-invite" component={AcceptInvite} />
            {/* AUTH-002 Task 3: recovery-email landing route. Reached from the
                reset link (ForgotPasswordPanel's `redirectTo`). Rendered
                OUTSIDE AuthGate — the recovery session is short-lived and the
                page inspects it directly to pick state 3 vs 3B. */}
            <Route path="/reset-password" component={ResetPasswordPage} />
            <Route>
              <AuthGate />
            </Route>
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
