import React from "react";
import { useListMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { MetricDefinitionTooltip } from "./MetricDefinitionTooltip";
import { Download } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, CartesianGrid, LineChart, Line,
  PieChart, Pie, Cell, Legend, ScatterChart, Scatter, ZAxis,
} from "recharts";
import { formatNumber } from "@/lib/format";
import { isExportableRender, downloadCsv } from "@/lib/csv";
import type { MetricDef } from "@workspace/metrics";
import type { MetricRange } from "./TimeRangeSelector";

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  borderRadius: "8px",
  border: "1px solid hsl(var(--border))",
};
const PIE_COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

interface SeriesPoint { label: string; value: number }

interface TierBMetricCardProps {
  def: MetricDef;
  range: MetricRange;
  /**
   * Row-height class token from the overview grid height contract
   * (OVW-001/002). Drives how much vertical room the card body takes: a
   * `tall` card stretches its chart to fill the row, a `compact` card keeps
   * its KPI body tight. Defaults to 'compact'.
   */
  size?: "compact" | "tall";
  suppressConnectionError?: boolean;
  onMetricError?: (error: unknown) => void;
}

/**
 * Tier-B metric card: fetches its value from /api/metrics (one React Query per
 * card, scoped by id+range) and renders per the metric's `render` type.
 * Header carries an (ⓘ) ARIA definition tooltip (term · formula/source ·
 * resolved window — see MetricDefinitionTooltip) and a CSV export of the data.
 *
 * Height contract: the Card root uses `h-full` so it stretches to whatever
 * row height the parent grid assigned (DraggableMetricGrid sets
 * grid-auto-rows + items-stretch). The body uses flex column layout so the
 * chart region flexes to fill leftover height rather than a fixed pixel
 * height — no `h-[…px]` here (banned by scripts/ci/check-metric-heights.mjs).
 */
export function TierBMetricCard({ def, range, size = "compact", suppressConnectionError, onMetricError }: TierBMetricCardProps) {
  const { data, isLoading, isError, error } = useListMetrics({
    tab: def.tab,
    keys: def.id,
    range,
  });

  React.useEffect(() => {
    if (isError && error) {
      onMetricError?.(data?.[def.id]);
    }
  }, [isError, error, data, def.id, onMetricError]);

  const payload = data?.[def.id];
  const hasData = !isLoading && !isError && !(payload && typeof payload === "object" && "error" in payload);
  const canExport = hasData && isExportableRender(def.render) && Array.isArray(payload) && payload.length > 0;

  const isConnectionError = payload && typeof payload === "object" && "error" in payload && String((payload as { error: unknown }).error).includes("invalid_grant");
  const shouldSuppressError = suppressConnectionError && isConnectionError;

  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="pb-2 space-y-0 flex flex-row items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {def.label}{def.unit && def.unit !== "count" ? ` (${def.unit})` : ""}
          </CardTitle>
          {/* HLP-001/002: ARIA definition tooltip (term · formula/source ·
              resolved window). Focus, click, and tap all open it; CI keeps
              coverage complete for kpi/stat metrics. */}
          <MetricDefinitionTooltip id={def.id} />
        </div>
        {canExport && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 -mr-1"
            aria-label={`Export ${def.label} as CSV`}
            onClick={() => downloadCsv(def.id, def.label, def.unit, payload as Record<string, unknown>[])}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {isLoading ? (
          <Skeleton className="flex-1 min-h-24 w-full" />
        ) : shouldSuppressError ? (
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="flex-1 min-h-20 w-full" />
          </div>
        ) : isError || (payload && typeof payload === "object" && "error" in payload) ? (
          <ErrorDetail payload={payload} />
        ) : (
          <Body def={def} size={size} payload={payload} />
        )}
      </CardContent>
    </Card>
  );
}

function ErrorDetail({ payload }: { payload: unknown }) {
  const message: string =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : "";
  return (
    <Empty className="flex-1 min-h-24 text-xs">
      <span>Unable to load metric</span>
      {message && (
        <span className="mt-1 block text-muted-foreground/70 break-words">{message}</span>
      )}
    </Empty>
  );
}

function Body({ def, size = "compact", payload }: { def: MetricDef; size?: "compact" | "tall"; payload: unknown }) {
  switch (def.render) {
    case "kpi":
    case "stat":
    case "gauge": {
      const v = (payload as { value?: number } | undefined)?.value ?? 0;
      const display = def.unit === "USD" ? `${formatNumber(v)}` : def.unit === "%" ? `${formatNumber(v)}%` : def.unit === "USD/kg" ? `${formatNumber(v)}/kg` : formatNumber(v);
      return <div className="text-2xl font-bold">{display}</div>;
    }
    case "area":
    case "bar":
    case "line": {
      const rows = (payload as SeriesPoint[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No data</Empty>;
      return <SeriesChart def={def} rows={rows} size={size} />;
    }
    case "donut": {
      const rows = (payload as SeriesPoint[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No data</Empty>;
      return <Donut rows={rows} />;
    }
    case "hbar": {
      const rows = (payload as SeriesPoint[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No data</Empty>;
      return <HBar rows={rows} />;
    }
    case "table": {
      const rows = (payload as Record<string, unknown>[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No rows</Empty>;
      return <Table rows={rows} />;
    }
    case "scatter": {
      const rows = (payload as Record<string, unknown>[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No data</Empty>;
      return <ScatterPlot rows={rows} />;
    }
    case "heatmap": {
      const rows = (payload as SeriesPoint[] | undefined) ?? [];
      if (rows.length === 0) return <Empty className="flex-1 min-h-36">No data</Empty>;
      return <Heatmap rows={rows} />;
    }
    default:
      return <Empty className="flex-1 min-h-24">Unsupported render type</Empty>;
  }
}

function SeriesChart({ def, rows, size = "compact" }: { def: MetricDef; rows: SeriesPoint[]; size?: "compact" | "tall" }) {
  // Tall cards (charts that fill a tall row) flex to fill leftover card
  // height; compact cards keep a short, fixed-aspect chart. Both avoid
  // `h-[…px]` (banned by scripts/ci/check-metric-heights.mjs) — compact uses
  // min-h utilities that read as semantic floors, not pixel locks.
  const chartClass = size === "tall" ? "flex-1 min-h-48" : "min-h-40";
  return (
    <div className={chartClass}>
      <ResponsiveContainer width="100%" height="100%">
        {def.render === "bar" ? (
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dy={8} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dx={-8} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : def.render === "line" ? (
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dy={8} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dx={-8} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          </LineChart>
        ) : (
          <AreaChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dy={8} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dx={-8} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary))" fillOpacity={0.15} />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function Donut({ rows }: { rows: SeriesPoint[] }) {
  return (
    <div className="flex-1 min-h-48">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="label" innerRadius={55} outerRadius={85} paddingAngle={2}>
            {rows.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function HBar({ rows }: { rows: SeriesPoint[] }) {
  return (
    <div className="flex-1 min-h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={rows}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} width={90} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ScatterPlot({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const [xKey, yKey] = cols;
  const data = rows
    .map((r) => ({ x: Number(r[xKey]), y: Number(r[yKey]) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return (
    <div className="flex-1 min-h-48">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis type="number" dataKey="x" name={xKey} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
          <YAxis type="number" dataKey="y" name={yKey} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
          <ZAxis range={[40, 40]} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter data={data} fill="hsl(var(--primary))" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function Heatmap({ rows }: { rows: SeriesPoint[] }) {
  const cellColor = (v: number) => {
    if (v >= 80) return "hsl(var(--destructive))";
    if (v >= 50) return "hsl(var(--chart-2))";
    if (v > 0) return "hsl(var(--primary))";
    return "hsl(var(--muted))";
  };
  return (
    <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
      {rows.map((r) => (
        <div
          key={r.label}
          className="rounded-md p-2 text-center text-xs text-white"
          style={{ backgroundColor: cellColor(r.value) }}
          title={`${r.label}: ${r.value}%`}
        >
          <div className="font-medium truncate">{r.label}</div>
          <div className="opacity-90">{r.value}%</div>
        </div>
      ))}
    </div>
  );
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  return (
    <div className="overflow-x-auto rounded-md border max-h-60 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
          <tr>{cols.map((c) => <th key={c} className="p-2 text-left">{c}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c} className="p-2">{String(r[c] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
