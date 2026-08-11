/**
 * Shared full-screen loading state (auth-session check, recovery-token
 * inspection, facility-existence check). Extracted from App.tsx so auth
 * sub-pages (ResetPasswordPage) can reuse the exact same chrome without a
 * circular import on App.tsx.
 */
export function LoadingScreen() {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-4 text-muted-foreground">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[43px] w-auto opacity-80" />
      <span>Loading…</span>
    </div>
  );
}
