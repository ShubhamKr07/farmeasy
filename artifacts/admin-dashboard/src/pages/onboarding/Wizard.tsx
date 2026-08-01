import { useState } from "react";
import { useGetWizardProgress } from "@workspace/api-client-react";
import { FarmBasics } from "./steps/FarmBasics";
import { LayoutGrid } from "./steps/LayoutGrid";
import { VendorAccounts } from "./steps/sensors/VendorAccounts";
import { DeviceRegistry } from "./steps/sensors/DeviceRegistry";
import { SensorReview } from "./steps/sensors/SensorReview";
import { Done } from "./steps/Done";
import { StepIndicator } from "./components/StepIndicator";
import { ResumeBanner } from "./components/ResumeBanner";

const STEP_ORDER = [
  "farm_basics",
  "layout",
  "sensors_accounts",
  "sensors_devices",
  "sensors_review",
  "done",
] as const;
type WizardStep = (typeof STEP_ORDER)[number];

/**
 * Onboarding wizard shell (WIZ-001). Internal-state stepper, not wouter
 * routes — the design README is explicit that no wizard step is
 * URL-addressable ("no close/escape; deep links to app routes redirect back
 * into the wizard until W4 completes"). Mounted by App.tsx's `FacilityGate`
 * in place of the normal dashboard `<Router/>` whenever the signed-in user
 * has no facility yet.
 */
export function Wizard() {
  const { data: progress, isLoading } = useGetWizardProgress();
  const [step, setStep] = useState<WizardStep>("farm_basics");
  const [resumed, setResumed] = useState(false);

  if (isLoading) return null; // AuthGate's LoadingScreen already covers the outer shell

  // Adjust state during render (React's documented pattern for syncing local
  // state from a query result — "You Might Not Need an Effect"), guarded by
  // `!resumed` so it only fires once: the same component reads its own
  // just-fetched prop and seeds its own state, not a child updating a parent.
  if (progress?.currentStep && !resumed) {
    setStep(progress.currentStep as WizardStep);
    setResumed(true);
  }

  const advance = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]);
  };

  // Resume banner is only meaningful while the wizard is still sitting on the
  // step the user was resumed to — once they advance past it, it's dismissed
  // (README: "dismissable-on-advance only, no close button"). Comparing
  // `step` to the originally-fetched `progress.currentStep` (which never
  // changes after the initial load) gives that one-shot dismiss for free
  // without any extra state.
  const showResumeBanner = resumed && progress?.currentStep === step;

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="h-16 bg-white border-b border-border flex items-center px-6 justify-between">
        <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[26px] w-auto" />
        {step === "farm_basics" ? (
          <StepIndicator current={step} />
        ) : (
          <span className="text-sm text-muted-foreground">
            Step {STEP_ORDER.indexOf(step) + 1} of {STEP_ORDER.length - 2}
          </span>
        )}
      </header>
      {showResumeBanner && <ResumeBanner />}
      {step === "farm_basics" && <FarmBasics onSaved={advance} />}
      {step === "layout" && <LayoutGrid onSaved={advance} />}
      {step === "sensors_accounts" && (
        <VendorAccounts onSaved={advance} onSkipAll={() => setStep("done")} />
      )}
      {step === "sensors_devices" && <DeviceRegistry onSaved={advance} />}
      {step === "sensors_review" && <SensorReview onFinish={advance} />}
      {step === "done" && <Done />}
    </div>
  );
}
