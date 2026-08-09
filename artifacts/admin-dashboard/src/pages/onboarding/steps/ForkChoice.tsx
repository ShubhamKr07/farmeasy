import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { FlaskConical, Sprout } from "lucide-react";

/**
 * W2 fork screen (TEN-013 Task 9). Renders BEFORE the `farm_basics` step when
 * the demo fork is enabled, the user has no facility yet, isn't already in a
 * demo, and has nothing to resume (see Wizard.tsx's `showFork` guard).
 *
 * Two large choices, matching the W2 wireframe:
 *  - "Set up your farm" → falls through to the normal `farm_basics` form
 *    (caller sets `showFork=false`, the wizard renders FarmBasics).
 *  - "Explore a demo"   → caller provisions the demo org in place and jumps
 *    the wizard straight to "done".
 *
 * Both buttons disable while `provisioning` is true (the demo-provision POST
 * is in flight) so a double-tap can't race two provisions. The demo button
 * also swaps in a spinner while provisioning for a clearer "working" affordance.
 *
 * Intentionally not a routed step (see Wizard.tsx's module doc comment: no
 * wizard step is URL-addressable) — this is a transient pre-step that
 * either resolves into the real wizard flow or exits it entirely.
 */
export function ForkChoice({
  onChoose,
  provisioning,
}: {
  onChoose: (choice: "real" | "demo") => void;
  provisioning: boolean;
}) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[560px] p-8">
        <h1 className="text-2xl font-bold">Welcome to FarmSmart</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Set up your own farm, or take a guided tour with sample data first.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <Button
            size="lg"
            className="h-auto flex-col items-start gap-1 py-5 text-left"
            disabled={provisioning}
            onClick={() => onChoose("real")}
          >
            <span className="flex items-center gap-2 text-base font-semibold">
              <Sprout className="h-5 w-5" />
              Set up your farm
            </span>
            <span className="font-normal text-primary-foreground/80 text-sm">
              Enter your details and build your own facility.
            </span>
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="h-auto flex-col items-start gap-1 py-5 text-left"
            disabled={provisioning}
            onClick={() => onChoose("demo")}
          >
            <span className="flex items-center gap-2 text-base font-semibold">
              {provisioning ? <Spinner className="h-5 w-5" /> : <FlaskConical className="h-5 w-5" />}
              Explore a demo
            </span>
            <span className="font-normal text-muted-foreground text-sm">
              Skip ahead with sample crops, cycles, and sensors.
            </span>
          </Button>
        </div>
      </Card>
    </div>
  );
}
