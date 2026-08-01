import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { setBaseUrl, setAuthTokenGetter, useGetWizardProgress } from "@workspace/api-client-react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
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

  return <FacilityGate />;
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
 * Wizard-completion guard (WIZ-001). Runs once the user is signed in: a
 * user who hasn't finished the wizard (no wizard_progress row yet, or a row
 * whose currentStep isn't "done") gets routed into the onboarding wizard
 * instead of any dashboard content; a user who has finished it
 * (currentStep === "done") gets the normal <Router/>. Gating on wizard
 * completion (not facility-existence) is what makes resume/re-entry work:
 * a user who submits farm_basics (which creates their facility) and then
 * abandons on a later step must still be routed back into the wizard on
 * their next sign-in, even though a facility already exists for them.
 * <Wizard/> has no wouter routes of its own, so this same gate — since it
 * wraps <Router/> entirely — also catches any deep link into /cycles,
 * /inventory, etc. and redirects it back into the wizard until W4
 * completes, with no per-route guard duplication needed.
 */
function FacilityGate() {
  const { data: progress, isLoading } = useGetWizardProgress();
  if (isLoading) return <LoadingScreen />;
  if (progress?.currentStep !== "done") return <Wizard />; // wizard incomplete -> wizard, no dashboard content
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
