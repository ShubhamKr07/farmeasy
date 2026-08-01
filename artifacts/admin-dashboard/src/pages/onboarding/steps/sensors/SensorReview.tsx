import React, { useState } from "react";
import { useListSensorAccounts } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AddedDevice } from "./DeviceRegistry";

interface DeviceGroup {
  label: string;
  entries: AddedDevice[];
}

function groupByLabel(devices: AddedDevice[]): DeviceGroup[] {
  const order: string[] = [];
  const map = new Map<string, AddedDevice[]>();
  for (const d of devices) {
    if (!map.has(d.label)) {
      map.set(d.label, []);
      order.push(d.label);
    }
    map.get(d.label)!.push(d);
  }
  return order.map((label) => ({ label, entries: map.get(label)! }));
}

function DeviceChip({ tone, children }: { tone: "neutral" | "placement"; children: React.ReactNode }) {
  return (
    <span
      className={
        tone === "placement"
          ? "inline-flex items-center rounded-[4px] px-2 py-0.5 text-[11.5px] font-medium bg-[hsl(142_40%_96%)] border border-[hsl(142_30%_88%)] text-[hsl(142_40%_25%)]"
          : "inline-flex items-center rounded-[4px] px-2 py-0.5 text-[11.5px] font-medium bg-[hsl(220_14%_96%)]"
      }
    >
      {children}
    </span>
  );
}

export function SensorReview({
  devices,
  onAddMore,
  onFinish,
}: {
  devices: AddedDevice[];
  onAddMore: () => void;
  onFinish: () => void;
}) {
  const { data: accounts } = useListSensorAccounts();
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const groups = groupByLabel(devices);

  return (
    <div className="flex justify-center pt-12 pb-12">
      <div className="w-[620px] space-y-6">
        <div>
          {/* Truthful literal count — computed from the actual accumulated
              list + the actual fetched accounts list, never hard-coded
              (SEN-004: "Title = truthful count"). */}
          <h1 className="text-2xl font-bold tracking-tight">
            {devices.length} device{devices.length === 1 ? "" : "s"}, {(accounts ?? []).length} account
            {(accounts ?? []).length === 1 ? "" : "s"}
          </h1>
          {/* Hard rule (WIZ-004 AC 4): no chart/tile/reading-placeholder
              anywhere on this screen — this sub-copy line is the only status
              indicator, on purpose. */}
          <p className="text-sm text-muted-foreground mt-1">
            Registered — data collection starts when polling launches. No charts until then.
          </p>
        </div>

        <Card className="p-0 overflow-hidden divide-y divide-border">
          {groups.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No devices added yet.</p>
          ) : (
            groups.map((group) => {
              const isExpanded = expandedLabel === group.label;
              const first = group.entries[0];
              return (
                <div key={group.label} className="p-4">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between text-left"
                    onClick={() => setExpandedLabel(isExpanded ? null : group.label)}
                  >
                    <span className="text-sm font-semibold">
                      {group.label}
                      {group.entries.length > 1 ? ` × ${group.entries.length}` : ""}
                    </span>
                    {group.entries.length > 1 && (
                      <span className="text-xs text-muted-foreground">Edit {isExpanded ? "▴" : "▾"}</span>
                    )}
                  </button>
                  {!isExpanded && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <DeviceChip tone="neutral">{first.types.join(", ")}</DeviceChip>
                      <DeviceChip tone="neutral">{first.accountLabel}</DeviceChip>
                      <DeviceChip tone="placement">
                        {group.entries.length > 1
                          ? group.entries.map((e) => e.placementSummary).join(" · ")
                          : first.placementSummary}
                      </DeviceChip>
                    </div>
                  )}
                  {isExpanded && (
                    <div className="mt-2 space-y-2">
                      {group.entries.map((entry, i) => (
                        <div key={i} className="flex flex-wrap gap-1.5 pl-3 border-l-2 border-border">
                          <DeviceChip tone="neutral">{entry.types.join(", ")}</DeviceChip>
                          <DeviceChip tone="neutral">{entry.accountLabel}</DeviceChip>
                          <DeviceChip tone="placement">{entry.placementSummary}</DeviceChip>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Card>

        <button type="button" className="text-sm underline text-muted-foreground" onClick={onAddMore}>
          + Add more devices
        </button>

        <div className="flex justify-between">
          <Button variant="outline" disabled title="Back navigation not yet wired in the wizard shell">
            ← Back
          </Button>
          <Button onClick={onFinish}>Finish setup →</Button>
        </div>
      </div>
    </div>
  );
}
