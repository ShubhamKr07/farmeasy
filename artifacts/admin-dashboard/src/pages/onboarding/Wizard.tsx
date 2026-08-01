import { useEffect, useState } from "react";
import { useGetWizardProgress, usePostWizardEvent } from "@workspace/api-client-react";
import { FarmBasics } from "./steps/FarmBasics";
import { LayoutGrid } from "./steps/LayoutGrid";
import { VendorAccounts } from "./steps/sensors/VendorAccounts";
import { DeviceRegistry } from "./steps/sensors/DeviceRegistry";
import type { AddedDevice } from "./steps/sensors/DeviceRegistry";
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
  const [addedDevices, setAddedDevices] = useState<AddedDevice[]>([]);
  const postEvent = usePostWizardEvent();

  // Adjust state during render (React's documented pattern for syncing local
  // state from a query result — "You Might Not Need an Effect"), guarded by
  // `!resumed` so it only fires once: the same component reads its own
  // just-fetched prop and seeds its own state, not a child updating a parent.
  // This isn't a hook call itself (just setStep/setResumed invocations), so
  // it's fine to keep above the isLoading early return below; it's also
  // naturally already isLoading-safe since `progress` is undefined/null
  // while loading, making `progress?.currentStep` falsy.
  if (progress?.currentStep && !resumed) {
    setStep(progress.currentStep as WizardStep);
    setResumed(true);
  }

  // WIZ-006: fire a "view" telemetry event once per step mount. The hook
  // call itself must be unconditional (Rules of Hooks) — kept above the
  // isLoading early return below, since on first mount isLoading is true and
  // an early return there would otherwise make this component call a
  // different number of hooks between the loading and loaded renders of the
  // same fiber. The isLoading guard INSIDE the effect body prevents firing a
  // spurious event for the default "farm_basics" step before the real
  // resumed step is known. Fire-and-forget (per README: "client does not
  // await/block on this") — no error handling needed beyond the mutation's
  // own default behavior, a dropped telemetry event should never surface to
  // the user or block the wizard.
  useEffect(() => {
    if (isLoading) return;
    postEvent.mutate({ data: { step, eventType: "view" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isLoading]);

  // WIZ-006: best-effort "abandon" event when the tab is hidden/closed while
  // still on this step. Same isLoading-guard reasoning as above — the hook
  // call is unconditional, only the effect body no-ops while loading.
  // Fire-and-forget, no guaranteed delivery if the tab closes immediately
  // after — acceptable per the brief's own "best-effort" framing, not a
  // metric that needs 100% delivery guarantees.
  useEffect(() => {
    if (isLoading) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        postEvent.mutate({ data: { step, eventType: "abandon" } });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isLoading]);

  if (isLoading) return null; // AuthGate's LoadingScreen already covers the outer shell

  const advance = () => {
    // "save" fires for the step being left (the one whose data was just
    // saved), before the transition to the next step.
    postEvent.mutate({ data: { step, eventType: "save" } });
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]);
  };

  // Distinct "skip" event (not a "save") so the circuit-breaker rule
  // (README: "if W3→W4 completion < 80%, W3.5 moves out of the wizard to
  // checklist-only") can tell "user skipped W3.5 entirely" apart from "user
  // completed W3.5" when this table is queried manually (automating the
  // circuit breaker itself is out of Phase 1 scope).
  const skipToDone = () => {
    postEvent.mutate({ data: { step, eventType: "skip" } });
    setStep("done");
  };

  // Lets the review screen's "+ Add more devices" link jump straight back to
  // the device-registry step — a local state transition (see the module doc
  // comment above: no wizard step is URL-addressable), not a route.
  const goToDevices = () => setStep("sensors_devices");

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
      {step === "sensors_accounts" && <VendorAccounts onSaved={advance} onSkipAll={skipToDone} />}
      {step === "sensors_devices" && (
        <DeviceRegistry onSaved={advance} onDeviceAdded={(d) => setAddedDevices((prev) => [...prev, d])} />
      )}
      {step === "sensors_review" && (
        <SensorReview devices={addedDevices} onAddMore={goToDevices} onFinish={advance} />
      )}
      {step === "done" && <Done />}
    </div>
  );
}
