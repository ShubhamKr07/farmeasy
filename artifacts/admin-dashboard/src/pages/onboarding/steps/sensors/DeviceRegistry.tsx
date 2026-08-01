import { useEffect, useState } from "react";
import { useGetLayout, useListSensorAccounts, useBulkCreateSensors } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import { PlacementLadder, getDefaultRung, type Rung, type MeasureType } from "./PlacementLadder";

const MEASURE_OPTIONS: { value: MeasureType; label: string }[] = [
  { value: "temp", label: "Temperature" },
  { value: "humidity", label: "Humidity" },
  { value: "ph", label: "pH" },
  { value: "ec", label: "EC" },
  { value: "water", label: "Water level" },
];

export interface AddedDevice {
  label: string;
  types: MeasureType[];
  accountLabel: string;
  placementSummary: string;
}

export function DeviceRegistry({
  onSaved,
  onDeviceAdded,
}: {
  onSaved: () => void;
  onDeviceAdded?: (device: AddedDevice) => void;
}) {
  const { data: layout } = useGetLayout();
  const { data: accounts } = useListSensorAccounts();
  const bulkCreate = useBulkCreateSensors();

  const [label, setLabel] = useState("");
  const [types, setTypes] = useState<MeasureType[]>([]);
  const [accountId, setAccountId] = useState<string>("local");
  const [rung, setRung] = useState<Rung>("room");
  const [rungManuallySet, setRungManuallySet] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const [channelIds, setChannelIds] = useState<number[]>([]);
  const [rackIds, setRackIds] = useState<number[]>([]);
  const [addedDevices, setAddedDevices] = useState<AddedDevice[]>([]);

  // Re-derive the default rung whenever the selected measures change, unless
  // the user has manually overridden it — matches "Selecting types pre-picks
  // the rung" (README) without fighting a manual choice on every keystroke.
  useEffect(() => {
    if (!rungManuallySet) setRung(getDefaultRung(types));
  }, [types, rungManuallySet]);

  const selectedRoom = layout?.find((r) => String(r.id) === roomId);
  const availableChannels = selectedRoom?.channels ?? [];
  const availableRacks = availableChannels.filter((c) => channelIds.includes(c.id)).flatMap((c) => c.racks);

  const toggleChannel = (id: number) => {
    setChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setRackIds([]); // channel selection changed — rack selection (scoped to channels) is no longer valid
  };

  const toggleRack = (id: number) => {
    setRackIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Placement-target count drives the button label and summary — this is
  // deliberately the number of PLACEMENT TARGETS (channels/racks selected),
  // NOT the number of sensors rows actually created server-side. A combo
  // probe with 2 measure types on 3 channels creates 6 rows (Task 8's
  // device-model: one row per measure x channel), but the UI always speaks
  // in terms of "N devices" meaning N placement targets, matching the
  // README's literal wording ("3 channels selected -> 3 devices, named by
  // channel"). Do not conflate this with the actual row count.
  const placementCount =
    rung === "facility"
      ? 1
      : rung === "channel"
        ? channelIds.length
        : rung === "rack"
          ? rackIds.length
          : roomId
            ? 1
            : 0;

  const canSubmit = label.trim().length > 0 && types.length > 0 && placementCount > 0 && !bulkCreate.isPending;

  const handleAdd = () => {
    if (!canSubmit) return;
    const payload =
      rung === "facility"
        ? { label: label.trim(), types, facilityWide: true }
        : rung === "room"
          ? { label: label.trim(), types, roomId: Number(roomId) }
          : rung === "channel"
            ? { label: label.trim(), types, channelIds }
            : { label: label.trim(), types, rackIds };

    bulkCreate.mutate(
      {
        data: {
          ...payload,
          sensorAccountId: accountId === "local" ? null : Number(accountId),
        },
      },
      {
        onSuccess: () => {
          const placementSummary =
            rung === "facility"
              ? "Whole facility"
              : rung === "room"
                ? selectedRoom?.name ?? "Room"
                : rung === "channel"
                  ? `${selectedRoom?.name ?? ""} · Ch ${availableChannels
                      .filter((c) => channelIds.includes(c.id))
                      .map((c) => c.label)
                      .join(", ")}`
                  : `${selectedRoom?.name ?? ""} · Rack ${availableRacks
                      .filter((r) => rackIds.includes(r.id))
                      .map((r) => r.label)
                      .join(", ")}`;
          const accountLabel =
            accountId === "local" ? "Local" : (accounts?.find((a) => String(a.id) === accountId)?.vendor ?? "Local");
          const newDevice: AddedDevice = { label: label.trim(), types, accountLabel, placementSummary };
          setAddedDevices((prev) => [...prev, newDevice]);
          onDeviceAdded?.(newDevice);
          setLabel("");
          setTypes([]);
          setChannelIds([]);
          setRackIds([]);
          setRungManuallySet(false);
          toast(`${label.trim()} added`);
        },
        onError: () => toast.error("Could not add this device. Please try again."),
      },
    );
  };

  return (
    <div className="flex justify-center pt-12 pb-12">
      <div className="w-[640px] space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Add your devices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Work down your hardware shelf — the form clears after each add.
          </p>
        </div>

        <Card className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="device-label">Device label</Label>
              <Input id="device-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Room climate probe" />
            </div>
            <div>
              <Label>Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local (none)</SelectItem>
                  {(accounts ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.vendor}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Measures</Label>
            <ToggleGroup type="multiple" value={types} onValueChange={(v) => setTypes(v as MeasureType[])}>
              {MEASURE_OPTIONS.map((m) => (
                <ToggleGroupItem key={m.value} value={m.value}>{m.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <PlacementLadder
            value={rung}
            onChange={(r) => {
              setRung(r);
              setRungManuallySet(true);
              setChannelIds([]);
              setRackIds([]);
            }}
            types={types}
            autoSelected={!rungManuallySet}
          />

          <div>
            <Label>Room</Label>
            <Select value={roomId} onValueChange={(v) => { setRoomId(v); setChannelIds([]); setRackIds([]); }}>
              <SelectTrigger><SelectValue placeholder="Select a room" /></SelectTrigger>
              <SelectContent>
                {(layout ?? []).map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(rung === "channel" || rung === "rack") && roomId && (
            <div>
              <div className="flex items-center justify-between">
                <Label>Channels</Label>
                <button
                  type="button"
                  className="text-xs underline text-muted-foreground"
                  onClick={() => setChannelIds(availableChannels.map((c) => c.id))}
                >
                  Select all
                </button>
              </div>
              <div className="flex flex-wrap gap-2 mt-1">
                {availableChannels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleChannel(c.id)}
                    className={
                      channelIds.includes(c.id)
                        ? "rounded-[6px] px-2 py-1 text-xs bg-primary text-primary-foreground"
                        : "rounded-[6px] px-2 py-1 text-xs border border-border"
                    }
                  >
                    {channelIds.includes(c.id) ? "✓ " : ""}
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rung === "rack" && channelIds.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <Label>Racks</Label>
                <button
                  type="button"
                  className="text-xs underline text-muted-foreground"
                  onClick={() => setRackIds(availableRacks.map((r) => r.id))}
                >
                  Select all
                </button>
              </div>
              <div className="flex flex-wrap gap-2 mt-1">
                {availableRacks.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggleRack(r.id)}
                    className={
                      rackIds.includes(r.id)
                        ? "rounded-[6px] px-2 py-1 text-xs bg-primary text-primary-foreground"
                        : "rounded-[6px] px-2 py-1 text-xs border border-border"
                    }
                  >
                    {rackIds.includes(r.id) ? "✓ " : ""}
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-xs text-muted-foreground">
              {placementCount} {rung === "channel" ? "channels" : rung === "rack" ? "racks" : "target"} selected → {placementCount} device{placementCount === 1 ? "" : "s"}
              {rung === "channel" ? ", named by channel" : ""}
            </span>
            <Button onClick={handleAdd} disabled={!canSubmit}>
              {bulkCreate.isPending ? "Adding…" : `Add ${placementCount} device${placementCount === 1 ? "" : "s"}`}
            </Button>
          </div>
        </Card>

        {addedDevices.length > 0 && (
          <div className="rounded-lg bg-[hsl(248_20%_95%)] p-3 text-xs space-y-1">
            <p className="text-muted-foreground font-medium">Added so far:</p>
            {addedDevices.map((d, i) => (
              <p key={i}>
                <span className="font-semibold">{d.label}</span> · {d.placementSummary}
              </p>
            ))}
          </div>
        )}

        <div className="flex justify-between">
          <Button variant="outline" disabled title="Back navigation not yet wired in the wizard shell">
            ← Accounts
          </Button>
          <Button onClick={onSaved}>Review →</Button>
        </div>
      </div>
    </div>
  );
}
