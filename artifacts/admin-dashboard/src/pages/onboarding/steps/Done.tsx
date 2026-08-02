import { useGetMyFacility } from "@workspace/api-client-react";
import { FarmReadinessCard } from "@/components/dashboard/FarmReadinessCard";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { QuickBooksCard } from "./done/QuickBooksCard";
import { MobileHandoffCard } from "./done/MobileHandoffCard";

export function Done() {
  const { data: facility } = useGetMyFacility();

  const handleGoToDashboard = () => {
    // Hard navigation (not a wouter navigate): the wizard isn't mounted inside
    // the router (see Wizard.tsx's module doc comment), so this forces
    // App.tsx's FacilityGate to re-evaluate — by this point currentStep is
    // already "done", so the gate now mounts <Router/> instead of <Wizard/>.
    window.location.assign("/");
  };

  return (
    <div className="flex justify-center pt-12 pb-12">
      <div className="w-[640px] space-y-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-9 w-9 text-green-600 shrink-0 mt-0.5" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {facility?.facilityName ?? "Your farm"} is set up
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Four things left before your first cycle — most happen on your phone.
            </p>
          </div>
        </div>

        <FarmReadinessCard mode="preview" />

        <QuickBooksCard />

        <MobileHandoffCard />

        <div className="flex justify-end pt-2">
          <Button onClick={handleGoToDashboard}>Go to dashboard →</Button>
        </div>
      </div>
    </div>
  );
}
