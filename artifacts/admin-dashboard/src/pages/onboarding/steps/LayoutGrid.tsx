import { useState } from "react";
import { useGetLayout, useCreateChannel, useCreateRack, useCreateTray } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ZoneCard, type ZoneState } from "./layout/ZoneCard";
import { LiveSchematic } from "./layout/LiveSchematic";
import { LabelPreviewStrip } from "./layout/LabelPreviewStrip";

type RoomName = "seeding" | "fertigation" | "harvesting";
const ROOMS: { name: RoomName; label: string; stageInitial: string }[] = [
  { name: "seeding", label: "Seeding", stageInitial: "S" },
  { name: "fertigation", label: "Fertigation", stageInitial: "F" },
  { name: "harvesting", label: "Harvesting", stageInitial: "H" },
];

const emptyZoneState = (): ZoneState => ({ channels: 0, racksPerChannel: 0, levelsPerRack: 0 });

export function LayoutGrid({ onSaved }: { onSaved: () => void }) {
  const { data: layout, refetch: refetchLayout } = useGetLayout();
  const [zoneStates, setZoneStates] = useState<Record<RoomName, ZoneState>>({
    seeding: emptyZoneState(),
    fertigation: emptyZoneState(),
    harvesting: emptyZoneState(),
  });
  const [expandedZone, setExpandedZone] = useState<RoomName>("seeding");
  const [submitting, setSubmitting] = useState(false);

  const createChannel = useCreateChannel();
  const createRack = useCreateRack();
  const createTray = useCreateTray();

  // Validation (README): >=1 channel per zone; non-negative integers only
  // (Stepper's own min={0} already guarantees non-negative — the only extra
  // rule to enforce here is the >=1-channel-per-zone minimum).
  const isValid = ROOMS.every((r) => zoneStates[r.name].channels >= 1);

  const activeZone = ROOMS.find((r) => r.name === expandedZone)!;
  const activeState = zoneStates[expandedZone];

  const handleSubmit = async () => {
    if (!isValid) return;
    setSubmitting(true);
    try {
      // Refetch fresh layout data right before submitting so a retry after a
      // partial failure can detect what's already been created and skip it.
      // This is a resume strategy, not a real backend transaction (no
      // bulk-create endpoint exists — out of scope for this task). It
      // correctly handles a full retry and a retry where one zone already
      // fully succeeded. A channel that failed partway through its OWN
      // racks/trays (not a whole-zone failure) is a known residual edge case
      // this can't fully resolve without a dedicated backend endpoint — in
      // that narrow case the user may need to check the Layout tab.
      const { data: freshLayout } = await refetchLayout();
      const currentLayout = freshLayout ?? layout ?? [];

      // Sequential, not Promise.all: channels must exist before their racks
      // can reference them, and racks before their trays — this is a real
      // data dependency chain, not an arbitrary choice to serialize.
      for (const room of ROOMS) {
        const state = zoneStates[room.name];
        const roomRow = currentLayout.find((r) => r.name === room.name);
        if (!roomRow) continue; // should never happen post-wizard-gate, but don't crash if it does

        const existingChannelCount = roomRow.channels.length;
        const channelsToCreate = Math.max(0, state.channels - existingChannelCount);
        if (channelsToCreate === 0) continue; // zone already has enough channels — assume already done

        for (let c = 0; c < channelsToCreate; c++) {
          const channelIndex = existingChannelCount + c + 1; // continue numbering from where we left off
          const channel = await createChannel.mutateAsync({
            data: { roomId: roomRow.id, label: `${room.stageInitial}-CH${channelIndex}` },
          });
          for (let r = 0; r < state.racksPerChannel; r++) {
            const rack = await createRack.mutateAsync({
              data: { channelId: channel.id, label: `R${r + 1}` },
            });
            for (let l = 0; l < state.levelsPerRack; l++) {
              await createTray.mutateAsync({ data: { rackId: rack.id, label: `S${l + 1}` } });
            }
          }
        }
      }
      onSaved();
    } catch (err) {
      console.error("[LayoutGrid] failed to save layout", err);
      toast.error(
        "Some of your layout may not have saved. You can safely try again — already-created channels won't be duplicated.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-9 py-9 md:px-[60px] max-w-[1400px] mx-auto">
      <h1 className="text-2xl font-bold tracking-tight">Map your growing space</h1>
      <p className="text-sm text-muted-foreground mt-1">
        For each zone, tell us how it's physically arranged. The schematic updates as you type.
      </p>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-[360px_1fr] gap-6">
        <div className="space-y-4">
          {ROOMS.map((room) => (
            <div key={room.name}>
              <ZoneCard
                zoneLabel={room.label}
                state={zoneStates[room.name]}
                onChange={(s) => setZoneStates((prev) => ({ ...prev, [room.name]: s }))}
                expanded={expandedZone === room.name}
                onToggleExpanded={() => setExpandedZone(room.name)}
              />
              {zoneStates[room.name].channels < 1 && (
                <p className="text-xs text-status-critical mt-1 px-1">Every zone needs at least 1 channel</p>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <LiveSchematic
            zoneLabel={activeZone.label}
            channels={activeState.channels}
            racksPerChannel={activeState.racksPerChannel}
            levelsPerRack={activeState.levelsPerRack}
          />
          <LabelPreviewStrip stageInitial={activeZone.stageInitial} />
        </div>
      </div>
      <div className="flex justify-between mt-8">
        {/* Wizard.tsx (Task 4) has no back-navigation callback wired between
            steps — only advance(). Rendering this disabled rather than
            inventing new Wizard.tsx plumbing outside this task's scope;
            flag as a follow-up if back-navigation between wizard steps is
            wanted later. */}
        <Button variant="outline" disabled title="Back navigation not yet wired in the wizard shell">
          ← Back
        </Button>
        <Button onClick={handleSubmit} disabled={!isValid || submitting}>
          {submitting ? "Creating…" : "Create layout →"}
        </Button>
      </div>
    </div>
  );
}
