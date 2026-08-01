import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function FarmBasics({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[560px] p-8">
        <h1 className="text-2xl font-bold">Tell us about your farm</h1>
        <p className="text-sm text-muted-foreground mt-1">Stub — Task 5 builds the real form.</p>
        <div className="flex justify-end mt-6">
          <Button onClick={onSaved}>Continue →</Button>
        </div>
      </Card>
    </div>
  );
}
