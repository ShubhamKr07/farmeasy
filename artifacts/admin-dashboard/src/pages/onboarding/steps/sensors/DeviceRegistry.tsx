import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function DeviceRegistry({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[640px] p-8">
        <h1 className="text-2xl font-bold">Add your devices</h1>
        <p className="text-sm text-muted-foreground mt-1">Stub — Task 10 builds the real device registry.</p>
        <div className="flex justify-end mt-6">
          <Button onClick={onSaved}>Review →</Button>
        </div>
      </Card>
    </div>
  );
}
