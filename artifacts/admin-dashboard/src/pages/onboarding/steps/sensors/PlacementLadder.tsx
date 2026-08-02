import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type Rung = "facility" | "room" | "channel" | "rack";
// Only the 5 measure types this backend's sensorTypeEnum actually supports —
// see the scope-correction note in the task brief. CO2/light-PPFD are
// deliberately absent, not an oversight.
export type MeasureType = "temp" | "humidity" | "ph" | "ec" | "water";

const RUNG_ORDER: Rung[] = ["facility", "room", "channel", "rack"];
const RUNG_LABELS: Record<Rung, string> = {
  facility: "Whole facility",
  room: "Room",
  channel: "Channel",
  rack: "Rack-shelf",
};

// Type-driven defaults (README): Temp/Humidity -> Room; pH/EC -> Channel;
// Water level -> Channel. Combo probes default to the DEEPEST rung among
// their selected types' individual defaults.
const DEFAULT_RUNG_BY_TYPE: Record<MeasureType, Rung> = {
  temp: "room",
  humidity: "room",
  ph: "channel",
  ec: "channel",
  water: "channel",
};

export function getDefaultRung(types: MeasureType[]): Rung {
  if (types.length === 0) return "room";
  return types
    .map((t) => DEFAULT_RUNG_BY_TYPE[t])
    .reduce((deepest, r) => (RUNG_ORDER.indexOf(r) > RUNG_ORDER.indexOf(deepest) ? r : deepest));
}

function explainDefault(types: MeasureType[]): string {
  if (types.includes("ph") || types.includes("ec")) {
    return "pH & EC probes usually sit in one channel's water line, so we pre-selected Channel. Change it if yours serves a whole room.";
  }
  if (types.includes("temp") || types.includes("humidity")) {
    return "Temperature and humidity sensors usually cover a whole room, so we pre-selected Room. Change it if yours is more specific.";
  }
  return "";
}

export function PlacementLadder({
  value,
  onChange,
  types,
  autoSelected,
}: {
  value: Rung;
  onChange: (rung: Rung) => void;
  types: MeasureType[];
  autoSelected: boolean;
}) {
  const explanation = autoSelected && types.length > 0 ? explainDefault(types) : "";
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium">Where is it measuring?</label>
      <ToggleGroup type="single" value={value} onValueChange={(v) => v && onChange(v as Rung)}>
        {RUNG_ORDER.map((rung) => (
          <ToggleGroupItem key={rung} value={rung}>
            {RUNG_LABELS[rung]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {explanation && (
        <div className="rounded-lg bg-[hsl(142_40%_97%)] border border-[hsl(142_30%_88%)] p-3 text-xs">
          {explanation}
        </div>
      )}
    </div>
  );
}
