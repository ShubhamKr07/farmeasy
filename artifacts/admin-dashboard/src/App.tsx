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
 * email/password form plus a Google OAuth button.
 */
function AuthGate() {
  const { session, loading } = useSupabaseSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[53px] w-auto" />
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
 * Shared full-screen loading state (auth-session check, facility-existence
 * check) — same visual treatment as the original inline `AuthGate` loading
 * branch, just reusable.
 */
function LoadingScreen() {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-4 text-muted-foreground">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[43px] w-auto opacity-80" />
      <span>Loading…</span>
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
          <AuthGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
