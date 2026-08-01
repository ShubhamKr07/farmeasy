import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function VendorAccounts({ onSaved, onSkipAll }: { onSaved: () => void; onSkipAll: () => void }) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[620px] p-8">
        <h1 className="text-2xl font-bold">Where does your hardware report?</h1>
        <p className="text-sm text-muted-foreground mt-1">Stub — Task 9 builds the real vendor-accounts form.</p>
        <div className="flex justify-between mt-6">
          <button type="button" className="text-sm underline" onClick={onSkipAll}>
            No vendor cloud — all my sensors are local
          </button>
          <Button onClick={onSaved}>Next: devices →</Button>
        </div>
      </Card>
    </div>
  );
}
