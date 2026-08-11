import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useOrgRole } from "@/hooks/use-org-role";
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
import NotFound from "@/pages/not-found";

import { AppLayout } from "@/components/layout/AppLayout";
import { Overview } from "@/pages/overview/Overview";
import { Cycles } from "@/pages/cycles/Cycles";
import { Inventory } from "@/pages/inventory/Inventory";
import { Shipments } from "@/pages/shipments/Shipments";
import { Accounting } from "@/pages/accounting/Accounting";
import { Layout } from "@/pages/layout/Layout";
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
 * Shows a Supabase-backed sign-in screen until the user is authenticated.
 * Mirrors the previous Clerk gate structure, swapping `<SignIn />` for an
 * email/password form plus a Google OAuth button. TEN-012 Task 9 adds a
 * "Create an account" toggle that switches to SignUpForm (availability-gated
 * via useSignupAvailability, which probes the same email field).
 */
function AuthGate() {
  const { session, loading } = useSupabaseSession();
  const { role, loading: roleLoading } = useOrgRole();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    const signIn = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setBusy(true);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      setBusy(false);
      if (signInError) setError(signInError.message);
    };

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
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
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
          <>
            <form onSubmit={signIn} className="w-full max-w-sm space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                Sign in
              </Button>
            </form>
            {/* AUTH-002 Task 3: "Forgot password?" link under the password
                field flips this auth screen to the ForgotPasswordPanel
                (state 1) — same panel, no route change. */}
            <Button
              variant="link"
              className="text-sm w-full max-w-sm -mt-2"
              onClick={() => setView("forgot")}
            >
              Forgot password?
            </Button>
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
        )}

        {showCreateAccountToggle && (
          <Button
            variant="link"
            className="text-sm"
            onClick={() => setView((v) => (v === "signin" ? "signup" : "signin"))}
          >
            {view === "signin"
              ? "Don't have an account? Create one"
              : "Already have an account? Sign in"}
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
  // the role claim resolves, then direct a technician to the mobile-app-only
  // denied screen instead of the dashboard. `useOrgRole()` is called
  // unconditionally above; these values are simply unused in the earlier
  // `loading` / `!session` early-return branches.
  if (roleLoading) {
    return <LoadingScreen />;
  }

  if (role === "technician") {
    return <TechnicianDeniedScreen />;
  }

  return (
    <ActiveFacilityProvider>
      <FacilityGate />
    </ActiveFacilityProvider>
  );
}

/**
 * AUTH-003: full-screen denied state for a technician who reaches the web
 * dashboard. Technicians are mobile-app-only; the server 403s
 * (`requireRole` middleware, ROLE_FORBIDDEN) are the real access control —
 * this is purely the directing UX so a technician isn't left staring at API
 * errors. Renders INSTEAD of <FacilityGate/>; the technician never reaches
 * the app shell.
 */
function TechnicianDeniedScreen() {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background text-center px-4">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
      <p className="text-muted-foreground max-w-sm">
        The dashboard is for admins — open the FarmSmart mobile app.
      </p>
      <Button variant="outline" onClick={() => supabase.auth.signOut()}>
        Sign out
      </Button>
    </div>
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
