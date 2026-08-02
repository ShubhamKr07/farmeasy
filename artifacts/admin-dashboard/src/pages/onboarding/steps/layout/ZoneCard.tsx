import { Card } from "@/components/ui/card";
import { Stepper } from "@/components/ui/stepper";

export interface ZoneState {
  channels: number;
  racksPerChannel: number;
  levelsPerRack: number;
}

export function ZoneCard({
  zoneLabel,
  state,
  onChange,
  expanded,
  onToggleExpanded,
}: {
  zoneLabel: string;
  state: ZoneState;
  onChange: (s: ZoneState) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  return (
    <Card className="p-4">
      <button type="button" onClick={onToggleExpanded} className="w-full text-left font-semibold text-sm">
        {zoneLabel}
      </button>
      {expanded ? (
        <div className="mt-3 space-y-3">
          <Stepper
            label="Channels"
            value={state.channels}
            min={0}
            onChange={(v) => onChange({ ...state, channels: v })}
          />
          <Stepper
            label="Racks / channel"
            value={state.racksPerChannel}
            min={0}
            onChange={(v) => onChange({ ...state, racksPerChannel: v })}
          />
          <Stepper
            label="Levels / rack"
            value={state.levelsPerRack}
            min={0}
            onChange={(v) => onChange({ ...state, levelsPerRack: v })}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground mt-1">
          {state.channels} ch · {state.racksPerChannel} racks · {state.levelsPerRack} levels
        </p>
      )}
    </Card>
  );
}
