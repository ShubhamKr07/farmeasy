import { useEffect, useState } from "react";
import {
  useGetWizardProgress,
  usePostWizardEvent,
  usePutWizardProgress,
  usePostFacilityReadinessEvent,
  RecordReadinessEventRequestEventKey,
} from "@workspace/api-client-react";
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
export function Wizard({
  facilityId,
  onFacilityCreated,
}: {
  facilityId: number | null;
  onFacilityCreated: (newFacilityId: number, organizationId: number) => void;
}) {
  const { data: progress, isLoading } = useGetWizardProgress(
    facilityId !== null ? { facilityId } : undefined,
  );
  const [step, setStep] = useState<WizardStep>("farm_basics");
  const [resumed, setResumed] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [addedDevices, setAddedDevices] = useState<AddedDevice[]>([]);
  const [createdFacilityId, setCreatedFacilityId] = useState<number | null>(facilityId);
  const postEvent = usePostWizardEvent();
  const putProgress = usePutWizardProgress();
  const postReadinessEvent = usePostFacilityReadinessEvent();

  // Adjust state during render (React's documented pattern for syncing local
  // state from a query result — "You Might Not Need an Effect"), guarded by
  // `!resumed` so it only fires once: the same component reads its own
  // just-fetched prop and seeds its own state, not a child updating a parent.
  // This isn't a hook call itself (just setStep/setResumed invocations), so
  // it's fine to keep above the isLoading early return below; it's also
  // naturally already isLoading-safe since `progress` is undefined/null
  // while loading, making `progress?.currentStep` falsy.
  // `!hasLoadedOnce` added (TEN-008 review cycle 4): without it, a LATER
  // ordinary refetch of this same query key (TanStack Query v5 defaults:
  // refetchOnWindowFocus/reconnect, see App.tsx's unconfigured QueryClient)
  // can land after the wizard_progress row is created by the very next PUT
  // (first-time onboarding / "Add facility" both start with no row, so
  // `progress?.currentStep` is falsy on the FIRST load and this effect
  // doesn't fire then) — that later refetch's real `currentStep` would still
  // satisfy `!resumed` and fire this effect, spuriously showing the "Welcome
  // back" banner mid-session or snapping `step` backward in a race with the
  // in-flight PUT. Once the component has finished loading once
  // (`hasLoadedOnce`), the resume decision is final either way: a genuine
  // resume already fired this branch on that same first load (before
  // `hasLoadedOnce` could have been set — see ordering note below), and a
  // no-row-yet first load has nothing to resume from ever again for this
  // component instance.
  if (progress?.currentStep && !resumed && !hasLoadedOnce) {
    setStep(progress.currentStep as WizardStep);
    setResumed(true);
  }

  // Tracks "has this component ever finished a load" (deliberately NOT the
  // same thing as `resumed` above, which only means "the resume-from-server
  // effect fired at least once"). `resumed` stays false whenever the initial
  // GET comes back with no row (the common case for both first-time
  // zero-facility onboarding and "Add facility": no wizard_progress row
  // exists yet the first time this mounts) — `hasLoadedOnce` instead just
  // means "isLoading has resolved to false at least once," set once and
  // never unset, same during-render-adjustment pattern as `resumed` above.
  // On the very first render pass, both this block and the resume-effect
  // block above read `resumed`/`hasLoadedOnce` from the same pre-update
  // values (both still false) — React's "adjust state during render" restart
  // (state changed mid-render, so the whole function body re-runs once more
  // before committing) is what lets the resume effect's setStep/setResumed
  // land using the pre-flip values, not this block's own textual position.
  // Genuine resume-from-reload is unaffected. Deliberately does NOT also force
  // `resumed = true` unconditionally here — doing so would make
  // `showResumeBanner` (`resumed && progress?.currentStep === step`) collapse
  // to just `progress?.currentStep === step`, which the wizard's own PUT
  // effect keeps true almost continuously (it upserts currentStep to match
  // local step after every change) — a near-certain false-positive banner on
  // any ordinary tab refocus, not just a narrow race.
  if (!isLoading && !hasLoadedOnce) {
    setHasLoadedOnce(true);
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

  // Persists currentStep so GET /wizard/progress can resume this user later
  // (WIZ-001 resume) and so FacilityGate (App.tsx) can tell wizard-in-progress
  // apart from wizard-complete. Same isLoading-guard reasoning as the "view"
  // telemetry effect above — hook call unconditional, only the effect body
  // no-ops while loading. Idempotent: re-PUTting the already-resumed step on
  // first load after a resume is harmless (same value written back).
  useEffect(() => {
    if (isLoading) return;
    putProgress.mutate({ data: { currentStep: step, facilityId: createdFacilityId ?? undefined } });
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

  // Only blank the screen for the component's very FIRST load (before
  // `hasLoadedOnce` is ever set) — AuthGate's LoadingScreen already covers
  // the outer shell for that case. A LATER isLoading=true, caused by
  // `facilityId` flipping from null to a real id (FacilityGate re-rendering
  // this same fiber right after "Add facility"'s first step, or first-time
  // zero-facility onboarding — both via finishAddFacility), points
  // useGetWizardProgress at a brand-new, never-cached query key even though
  // this component already knows exactly what step it's on locally (`step`
  // was already advanced in the same batched render). Blanking the screen
  // for that round-trip would be a visible flash with nothing left to wait
  // for — `progress` isn't used to decide what to render below, only to
  // seed local state once via the `resumed` effect above, which is already
  // one-shot-guarded and won't be re-triggered by this later fetch.
  if (isLoading && !hasLoadedOnce) return null;

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
    postReadinessEvent.mutate({ data: { eventKey: RecordReadinessEventRequestEventKey.sensors_skipped } });
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
      {step === "farm_basics" && (
        <FarmBasics
          onSaved={(data) => {
            setCreatedFacilityId(data.facilityId);
            onFacilityCreated(data.facilityId, data.organizationId);
            advance();
          }}
        />
      )}
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
