import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function SensorReview({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[620px] p-8">
        <h1 className="text-2xl font-bold">Review</h1>
        <p className="text-sm text-muted-foreground mt-1">Stub — Task 11 builds the real review screen.</p>
        <div className="flex justify-end mt-6">
          <Button onClick={onFinish}>Finish setup →</Button>
        </div>
      </Card>
    </div>
  );
}
