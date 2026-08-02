/**
 * "Picking up where you left off" — shown once when a returning user's
 * wizard progress is restored from the server (WIZ-001 resume). Per the
 * design handoff (wireframe 1b) and the plan brief: dismissable only by
 * advancing past the resumed step, never by an explicit close control — the
 * wizard has no dismiss/escape affordances anywhere (Global Constraints).
 */
export function ResumeBanner() {
  return (
    <div className="border-b border-dashed border-border bg-muted/50 px-6 py-2 text-sm text-muted-foreground">
      Picking up where you left off.
    </div>
  );
}
