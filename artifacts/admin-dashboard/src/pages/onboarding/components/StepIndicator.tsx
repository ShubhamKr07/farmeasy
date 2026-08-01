import { cn } from "@/lib/utils";

/**
 * The wizard's 6 internal step keys (mirrors `wizard_step` DB enum /
 * Wizard.tsx's STEP_ORDER), collapsed here into the 4 user-facing stages the
 * design README specifies: "Farm basics · Layout · Sensors · Done" — the
 * three sensors_* sub-steps (accounts/devices/review) all light up the same
 * "Sensors" circle.
 */
type WizardStepKey =
  | "farm_basics"
  | "layout"
  | "sensors_accounts"
  | "sensors_devices"
  | "sensors_review"
  | "done";

const DISPLAY_STEPS: ReadonlyArray<{ label: string; matches: readonly WizardStepKey[] }> = [
  { label: "Farm basics", matches: ["farm_basics"] },
  { label: "Layout", matches: ["layout"] },
  { label: "Sensors", matches: ["sensors_accounts", "sensors_devices", "sensors_review"] },
  { label: "Done", matches: ["done"] },
];

function activeDisplayIndex(current: WizardStepKey): number {
  const idx = DISPLAY_STEPS.findIndex((s) => s.matches.includes(current));
  return idx === -1 ? 0 : idx;
}

/**
 * README spec (design_handoff_onboarding_phase1/README.md, "Wizard shell"):
 * 24px numbered circles; active = brand-green fill, white text; inactive =
 * white fill, hairline border, gray text; 56px hairline connectors.
 */
export function StepIndicator({ current }: { current: WizardStepKey }) {
  const activeIndex = activeDisplayIndex(current);

  return (
    <ol className="flex items-center">
      {DISPLAY_STEPS.map((step, i) => (
        <li key={step.label} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <div
              className={cn(
                "h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-xs font-medium",
                i === activeIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-white border border-border text-muted-foreground",
              )}
            >
              {i + 1}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{step.label}</span>
          </div>
          {i < DISPLAY_STEPS.length - 1 && (
            <div className="h-px w-14 bg-border mx-2 mb-5" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  );
}
