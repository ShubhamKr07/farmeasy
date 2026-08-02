import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFacilityReadiness,
  usePostFacilityReadinessEvent,
  getGetFacilityReadinessQueryKey,
  RecordReadinessEventRequestEventKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useFarmReadinessCollapsed } from "@/hooks/use-farm-readiness-collapsed";

const TOTAL_ITEMS = 7;

// Maps an item's key to the event key its "skipped" state's undo action must
// fire — only these two items can ever be in the "skipped" state (per Task
// 12's handler: sensors_skipped / quickbooks_skipped are the only skip
// events). Typed against the real generated enum so the mutate() call below
// is fully type-checked, rather than cast through `as never`.
const UNDO_EVENT_KEY: Record<string, RecordReadinessEventRequestEventKey> = {
  sensors_registered: RecordReadinessEventRequestEventKey.sensors_skipped,
  quickbooks_connected: RecordReadinessEventRequestEventKey.quickbooks_skipped,
};

export function FarmReadinessCard({ mode }: { mode: "dashboard" | "preview" }) {
  const { data } = useGetFacilityReadiness();
  const queryClient = useQueryClient();
  const postEvent = usePostFacilityReadinessEvent();
  const { collapsed, toggle } = useFarmReadinessCollapsed();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetFacilityReadinessQueryKey() });

  if (!data) return null;
  const { items, completedCount } = data;

  // Retire rule (CHK-003): items 1-4 all done -> this card stops rendering
  // on the dashboard entirely. Items 5-7 migrating to Settings.tsx is Task
  // 16's job, not this component's — this is the ONLY retire behavior this
  // task implements.
  const coreItemsDone = items.slice(0, 4).every((i) => i.state === "done");
  if (mode === "dashboard" && coreItemsDone) return null;

  const handleUndo = (itemKey: string) => {
    const eventKey = UNDO_EVENT_KEY[itemKey];
    if (!eventKey) return;
    postEvent.mutate({ data: { eventKey, undo: true } }, { onSuccess: invalidate });
  };

  // Collapse behavior (CHK-003) only applies on the dashboard — the W4
  // "preview" usage always shows the card fully expanded, since it's the
  // user's very first look at it.
  if (mode === "dashboard" && collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1.5 text-sm"
      >
        <span className="h-2 w-2 rounded-full bg-primary" />
        Farm Readiness · {completedCount}/{TOTAL_ITEMS} ▸
      </button>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-base font-semibold">Farm Readiness</h2>
        <div className="flex items-center gap-3">
          <Progress value={(completedCount / TOTAL_ITEMS) * 100} className="w-[140px]" />
          <span className="text-sm text-muted-foreground">
            {completedCount} of {TOTAL_ITEMS}
          </span>
          {mode === "dashboard" && (
            <button type="button" onClick={toggle} className="text-sm text-muted-foreground">
              Collapse ⌄
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-9 gap-y-3">
        {items.map((item) => (
          <div key={item.key} className="flex items-start gap-2">
            <span
              className={
                item.state === "done"
                  ? "mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full bg-primary flex items-center justify-center text-white text-[10px]"
                  : item.state === "interim"
                    ? "mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border-2 border-status-warn"
                    : item.state === "skipped"
                      ? "mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border-2 border-border bg-muted"
                      : "mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border-2 border-border"
              }
            >
              {item.state === "done" ? "✓" : null}
            </span>
            <div>
              <p className={item.state === "done" ? "text-sm line-through text-muted-foreground" : "text-sm"}>
                {item.label}
                {typeof item.count === "number" ? ` (${item.count})` : ""}
              </p>
              {item.state === "interim" && (
                <p className="text-xs text-status-warn">— PDF downloaded, waiting for first shelf scan</p>
              )}
              {item.state === "skipped" && (
                <p className="text-xs text-muted-foreground">
                  skipped —{" "}
                  <button type="button" className="underline" onClick={() => handleUndo(item.key)}>
                    undo from {item.key === "sensors_registered" ? "Sensors" : "Accounting"}
                  </button>
                </p>
              )}
              {item.state !== "done" && item.state !== "skipped" && item.deepLink && (
                <Link href={item.deepLink} className="text-xs text-primary underline">
                  Go →
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
