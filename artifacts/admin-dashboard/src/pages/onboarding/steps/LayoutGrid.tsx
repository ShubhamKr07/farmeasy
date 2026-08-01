import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function LayoutGrid({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[560px] p-8">
        <h1 className="text-2xl font-bold">Map your growing space</h1>
        <p className="text-sm text-muted-foreground mt-1">Stub — Task 6 builds the real layout grid.</p>
        <div className="flex justify-end mt-6">
          <Button onClick={onSaved}>Create layout →</Button>
        </div>
      </Card>
    </div>
  );
}
