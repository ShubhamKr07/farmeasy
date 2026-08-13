import React from "react";
import { useListCycles } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Leaf, Sprout, Droplets, Scissors } from "lucide-react";
import { QueryError } from "@/components/ui/query-error";

const STAGE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  germination: { label: "Germination", variant: "secondary" },
  fertigation:  { label: "Fertigation",  variant: "default"   },
  harvest:      { label: "Harvest Ready", variant: "destructive" },
};

interface SeedGroup {
  seedName: string;
  qrCodes: string[];
  cycles: { shortId: string; trayPosition: string | null | undefined; status: string; fullTrays: number; halfTrays: number }[];
  totalTrays: number;
}

export function SeedLotsPanel() {
  const { data: cycles, isLoading, isError, refetch } = useListCycles({ status: "ongoing" });

  const grouped: SeedGroup[] = React.useMemo(() => {
    if (!cycles) return [];
    const map = new Map<string, SeedGroup>();
    for (const c of cycles) {
      if (!map.has(c.seedName)) {
        map.set(c.seedName, { seedName: c.seedName, qrCodes: [], cycles: [], totalTrays: 0 });
      }
      const g = map.get(c.seedName)!;
      g.qrCodes.push(...c.seedLotQrCodes);
      g.cycles.push({ shortId: c.shortId, trayPosition: c.trayPosition, status: c.status, fullTrays: c.fullTrays, halfTrays: c.halfTrays });
      g.totalTrays += c.fullTrays + c.halfTrays;
    }
    return Array.from(map.values()).sort((a, b) => b.totalTrays - a.totalTrays);
  }, [cycles]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Leaf className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-xl font-bold tracking-tight">Active Seed Lots</h2>
          <p className="text-sm text-muted-foreground">{grouped.length} varieties currently in rotation</p>
        </div>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Sprout className="h-3 w-3" /> Germinating</p>
          <p className="text-2xl font-bold">{(cycles || []).filter((c) => c.status === "germination").length}</p>
          <p className="text-xs text-muted-foreground">cycles</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Droplets className="h-3 w-3" /> Fertigating</p>
          <p className="text-2xl font-bold">{(cycles || []).filter((c) => c.status === "fertigation").length}</p>
          <p className="text-xs text-muted-foreground">cycles</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Scissors className="h-3 w-3" /> Harvest Ready</p>
          <p className="text-2xl font-bold">{(cycles || []).filter((c) => c.status === "harvest").length}</p>
          <p className="text-xs text-muted-foreground">cycles</p>
        </div>
      </div>

      {/* Per-variety breakdown */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3,4].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : isError ? (
        <QueryError resource="seed lots" onRetry={() => refetch()} />
      ) : grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Leaf className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">No active seed lots</p>
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((g) => (
            <div key={g.seedName} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold">{g.seedName}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {g.cycles.length} cycle{g.cycles.length !== 1 ? "s" : ""} · {g.totalTrays} trays total
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {[...new Set(g.qrCodes)].map((qr) => (
                    <span key={qr} className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded border text-muted-foreground">
                      {qr}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {g.cycles.map((c) => {
                  const stageMeta = STAGE_BADGE[c.status];
                  return (
                    <div key={c.shortId} className="flex items-center gap-1.5 bg-muted/60 rounded-md px-2.5 py-1.5 text-xs">
                      <span className="font-mono text-muted-foreground">#{c.shortId}</span>
                      <Badge variant={stageMeta?.variant ?? "outline"} className="text-xs h-4 px-1">
                        {stageMeta?.label ?? c.status}
                      </Badge>
                      {c.trayPosition && (
                        <span className="text-muted-foreground">{c.trayPosition}</span>
                      )}
                      <span className="text-muted-foreground">{c.fullTrays + c.halfTrays} trays</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
