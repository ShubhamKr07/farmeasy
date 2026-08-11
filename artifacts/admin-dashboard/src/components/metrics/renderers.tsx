import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Empty } from "@/components/ui/empty";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, CartesianGrid, Legend, LineChart, Line,
  PieChart, Pie, Cell,
} from "recharts";
import { formatNumber } from "@/lib/format";
import { a11yClick } from "@/lib/utils";
import { usePanel } from "@/context/PanelContext";
import { downloadCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import {
  Sprout, Layers, Factory, AlertTriangle, Leaf, TrendingUp, Package, Download,
} from "lucide-react";
import type { MetricDef } from "@workspace/metrics";
import type {
  DashboardStats, Alert, Shipment, InventoryItem, ChartDataPoint,
} from "@workspace/api-client-react";

export interface MetricDataMap {
  dashboard?: DashboardStats;
  alerts?: Alert[];
  shipments?: Shipment[];
  inventory?: InventoryItem[];
}

export interface RendererProps {
  def: MetricDef;
  data: MetricDataMap;
}

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  borderRadius: "8px",
  border: "1px solid hsl(var(--border))",
};
const PIE_COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

// ── Overview: KPI cards (reproduce today's widgets verbatim) ──────────────

function YieldWeekCard({ data }: RendererProps) {
  const d = data.dashboard;
  const yw = d?.yieldByWeek || [];
  const last = yw[yw.length - 1]?.value ?? 0;
  const prev = yw[yw.length - 2]?.value ?? 0;
  const delta = prev > 0 ? ((last - prev) / prev) * 100 : null;
  // OVW-002: Total Yield is a `tall` card. The yieldByWeek series is already
  // in the dashboard payload — no new fetch. The spark/mini-trend chart fills
  // what was previously dead space under the KPI value, so the card's body
  // grows to match its tall row siblings instead of leaving a gap. Card root
  // is h-full + flex-col so the chart region flexes to fill leftover height
  // (no fixed pixel heights — banned by scripts/ci/check-metric-heights.mjs).
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 shrink-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Total Yield (Week)</CardTitle>
        <Sprout className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="text-2xl font-bold" data-testid="text-yield-week">
          {formatNumber(d?.totalYieldThisWeek || 0)} kg
        </div>
        {delta != null ? (
          <p className={`text-xs mt-1 flex items-center gap-1 ${delta >= 0 ? "text-status-ok" : "text-status-warn"}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}% vs last week
          </p>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">
            {formatNumber(d?.totalYieldThisMonth || 0)} kg this month
          </p>
        )}
        {yw.length > 1 && (
          <div className="flex-1 min-h-24 mt-3" aria-label="Yield trend, last 4 weeks">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={yw} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} dy={6} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11 }} width={32} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${formatNumber(v)} kg`, "Yield"]} />
                <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function clickableCardClass(tone: "primary" | "warn" | "destructive") {
  const border =
    tone === "warn" ? "hover:border-status-warn/50"
    : tone === "destructive" ? "hover:border-destructive/50"
    : "hover:border-primary/50";
  return `shadow-sm h-full cursor-pointer ${border} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`;
}

function ActiveCyclesCard({ data }: RendererProps) {
  const d = data.dashboard;
  const { open } = usePanel();
  return (
    <Card className={clickableCardClass("primary")} {...a11yClick(() => open("cycles"))} title="Open Active Cycles">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Active Cycles</CardTitle>
        <Factory className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid="text-active-cycles">
          {formatNumber(d?.totalRunningCycles || 0)}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {d?.activeCropTypes || 0} crop types · <span className="text-primary">View →</span>
        </p>
      </CardContent>
    </Card>
  );
}

function ChannelUtilKpiCard({ data }: RendererProps) {
  const d = data.dashboard;
  const running = d?.totalRunningCycles || 0;
  const total = d?.totalChannels ?? 0;
  const pct = ((d?.channelUtilization || 0) * 100).toFixed(1);
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 shrink-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Channel Utilization</CardTitle>
        <Layers className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <div className="text-2xl font-bold" data-testid="text-channel-util">{pct}%</div>
        <p className="text-xs text-muted-foreground mt-1">{running} of {total} channels active</p>
      </CardContent>
    </Card>
  );
}

function BadTraysCard({ data }: RendererProps) {
  const d = data.dashboard;
  const { open } = usePanel();
  return (
    <Card className={clickableCardClass("destructive")} {...a11yClick(() => open("bad-trays"))} title="Open Bad Trays Analysis">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Bad Trays</CardTitle>
        <AlertTriangle className="h-4 w-4 text-destructive" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-destructive" data-testid="text-bad-trays">
          {formatNumber(d?.totalBadTrays || 0)}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {d?.badTraysCount || 0} added this week · <span className="text-primary">View →</span>
        </p>
      </CardContent>
    </Card>
  );
}

function ActiveSeedLotsCard({ data }: RendererProps) {
  const d = data.dashboard;
  const { open } = usePanel();
  return (
    <Card className={clickableCardClass("primary")} {...a11yClick(() => open("seed-lots"))} title="Open Active Seed Lots">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Active Seed Lots</CardTitle>
        <Leaf className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{formatNumber(d?.activeSeedLots || 0)}</div>
        <p className="text-xs text-muted-foreground mt-1">Currently in rotation · <span className="text-primary">View →</span></p>
      </CardContent>
    </Card>
  );
}

function AlertsActionCard({ data }: RendererProps) {
  const d = data.dashboard;
  const alerts = data.alerts || [];
  const { open } = usePanel();
  const critical = (d as { criticalAlertsCount?: number })?.criticalAlertsCount || 0;
  return (
    <Card className={clickableCardClass("warn")} {...a11yClick(() => open("alerts"))} title="Open System Alerts">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Alerts Requiring Action</CardTitle>
        <AlertTriangle className="h-4 w-4 text-status-warn" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-status-warn">{alerts.length}</div>
        <p className="text-xs text-muted-foreground mt-1">{critical} critical · <span className="text-primary">View →</span></p>
      </CardContent>
    </Card>
  );
}

function CyclesActionNeededCard({ data }: RendererProps) {
  const d = data.dashboard;
  const { open } = usePanel();
  return (
    <Card className={clickableCardClass("primary")} {...a11yClick(() => open("action-required"))} title="Open Cycles Needing Action">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Cycles Needing Action</CardTitle>
        <TrendingUp className="h-4 w-4 text-primary" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{(d?.actionRequired || []).length}</div>
        <p className="text-xs text-muted-foreground mt-1">Overdue transitions · <span className="text-primary">View →</span></p>
      </CardContent>
    </Card>
  );
}

// ── Overview: charts ──────────────────────────────────────────────────────

function YieldByWeekChart({ data }: RendererProps) {
  const yw = data.dashboard?.yieldByWeek || [];
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>Yield by Week</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={yw}>
              <defs>
                <linearGradient id="colorYield" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={-10} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${formatNumber(v)} kg`, "Yield"]} />
              <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorYield)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function combinedDay(d: DashboardStats | undefined) {
  const yd = d?.yieldByDay || [];
  const sd = d?.seedingByDay || [];
  const bd = d?.badTrayByDay || [];
  return yd.map((p, i) => ({ label: p.label, yield: p.value, seeding: sd[i]?.value || 0, badTrays: bd[i]?.value || 0 }));
}

function DailyYieldSeedingChart({ data }: RendererProps) {
  const rows = combinedDay(data.dashboard);
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>Daily Yield vs Seeding</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dy={10} />
              <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={-10} />
              <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={10} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar yAxisId="left" dataKey="yield" name="Yield (kg)" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="seeding" name="Seeding (g)" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function Trend7dChart({ data }: RendererProps) {
  const rows = combinedDay(data.dashboard);
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>7-Day Trend: Yield · Seeding · Bad Trays</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows}>
              <defs>
                <linearGradient id="gYield" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} /><stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} /></linearGradient>
                <linearGradient id="gSeeding" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.25} /><stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0} /></linearGradient>
                <linearGradient id="gBad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.2} /><stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={-10} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Area type="monotone" dataKey="yield" name="Yield (kg)" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#gYield)" />
              <Area type="monotone" dataKey="seeding" name="Seeding (g)" stroke="hsl(var(--chart-2))" strokeWidth={2} fill="url(#gSeeding)" />
              <Area type="monotone" dataKey="badTrays" name="Bad Trays (g)" stroke="hsl(var(--destructive))" strokeWidth={2} fill="url(#gBad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ChannelUtilProgressCard({ data }: RendererProps) {
  const d = data.dashboard;
  const running = d?.totalRunningCycles || 0;
  const total = d?.totalChannels ?? 0;
  const pct = Number(((d?.channelUtilization || 0) * 100).toFixed(1));
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>Channel Utilization</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col justify-center">
        <div className="flex flex-col items-center justify-center text-center py-4">
          <div className="text-4xl font-bold text-primary">{pct}%</div>
          <p className="text-xs text-muted-foreground mt-1">{running} of {total} channels active</p>
        </div>
        <Progress value={pct} className="h-2 mb-4" />
        <div className="flex justify-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-primary" /><span>Active ({running})</span></div>
          <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-muted border border-border" /><span>Idle ({Math.max(0, total - running)})</span></div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActionRequiredListCard({ data }: RendererProps) {
  const items = data.dashboard?.actionRequired || [];
  return (
    <Card className="shadow-sm h-full flex flex-col lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between shrink-0">
        <CardTitle>Action Required</CardTitle>
        {items.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Export Action Required as CSV"
            onClick={() => downloadCsv(
              "ov.cycles.actionRequiredList",
              "Action Required",
              undefined,
              items.map((i) => ({ seedName: i.seedName, cycleShortId: i.cycleShortId, type: i.type, daysOverdue: i.daysOverdue })),
            )}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center min-h-40 text-muted-foreground">
            <Package className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">All cycles on schedule</p>
          </div>
        ) : (
          <div className="flex-1 divide-y divide-border rounded-md border overflow-hidden overflow-y-auto min-h-0">
            {items.map((item) => (
              <div key={item.cycleId} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <span className="font-medium">{item.seedName}</span>
                  <span className="text-muted-foreground ml-2 text-xs">#{item.cycleShortId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={item.type === "harvest" ? "destructive" : "secondary"}>{item.type}</Badge>
                  <span className="text-xs text-destructive font-medium">{item.daysOverdue}d overdue</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Generic Tier-A fallbacks ──────────────────────────────────────────────

function GenericKpiCard({ def, data }: RendererProps) {
  const d = data.dashboard;
  let value: number | string = "—";
  if (def.source === "dashboard") {
    if (def.dataKey === "sensorStatus" && d?.sensorStatus) {
      const s = d.sensorStatus;
      value =
        def.id === "ov.sensor.currentTemp" ? (s.tempCelsius == null ? "—" : formatNumber(s.tempCelsius))
        : def.id === "ov.sensor.currentPh" ? (s.acidityPh == null ? "—" : formatNumber(s.acidityPh))
        : def.id === "ov.sensor.currentHumidity" ? (s.humidityPct == null ? "—" : `${formatNumber(s.humidityPct)}%`)
        : def.id === "ov.sensor.currentWater" ? (s.waterLevelPct == null ? "—" : `${formatNumber(s.waterLevelPct)}%`)
        : def.id === "ov.sensor.onlineRatio" ? `${s.sensorsOnline}/${s.sensorsTotal}`
        : "—";
    } else if (def.dataKey === "criticalAlertsCount") {
      value = formatNumber((d as { criticalAlertsCount?: number })?.criticalAlertsCount || 0);
    } else if (def.dataKey === "activeCropTypes") {
      value = formatNumber(d?.activeCropTypes || 0);
    } else {
      value = formatNumber(((d as unknown as Record<string, unknown>)?.[def.dataKey] as number) || 0);
    }
  }
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="pb-2 space-y-0 shrink-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {def.label}{def.unit && def.unit !== "count" ? ` (${def.unit})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col"><div className="text-2xl font-bold">{value}</div></CardContent>
    </Card>
  );
}

function GenericSeriesChart({ def, data }: RendererProps) {
  const d = data.dashboard;
  const series = ((d as unknown as Record<string, unknown>)?.[def.dataKey] as ChartDataPoint[] | undefined) || [];
  if (series.length === 0) return <Card className="shadow-sm h-full"><CardContent><Empty className="flex-1 min-h-36">{`${def.label} — no data`}</Empty></CardContent></Card>;
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>{def.label}</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            {def.render === "bar" ? (
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={-10} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            ) : (
              <AreaChart data={series}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} dx={-10} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary))" fillOpacity={0.15} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Shipments Tier-A cards ────────────────────────────────────────────────

function sum(items: Shipment[], field: "yieldSoldKg" | "revenueUsd"): number {
  return items.reduce((acc, s) => acc + (s[field] ?? 0), 0);
}

function ShipmentsKpiCard({ def, data }: RendererProps) {
  const items = data.shipments || [];
  let value = 0;
  let suffix = "";
  switch (def.id) {
    case "sh.sold.total": value = sum(items, "yieldSoldKg"); suffix = " kg"; break;
    case "sh.rev.total": value = sum(items, "revenueUsd"); suffix = ""; break;
    case "sh.rev.avgPerShip": value = items.length ? sum(items, "revenueUsd") / items.length : 0; break;
    case "sh.sold.avgPerShip": value = items.length ? sum(items, "yieldSoldKg") / items.length : 0; suffix = " kg"; break;
    case "sh.aov": value = items.length ? sum(items, "revenueUsd") / items.length : 0; break;
    case "sh.rev.thisMonth": {
      const ms = new Date(); ms.setDate(1); ms.setHours(0, 0, 0, 0);
      value = items.filter((s) => s.shippingDate && new Date(s.shippingDate) >= ms).reduce((a, s) => a + (s.revenueUsd ?? 0), 0);
      break;
    }
    case "sh.status.complete": value = items.filter((s) => s.status === "complete").length; break;
    case "sh.status.pending": value = items.filter((s) => s.status === "pending").length; break;
    case "sh.status.inProgress": value = items.filter((s) => s.status === "in_progress").length; break;
    case "sh.clients.count": value = new Set(items.map((s) => s.client)).size; break;
    default: value = 0;
  }
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="pb-2 space-y-0 shrink-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {def.label}{def.unit && def.unit !== "count" ? ` (${def.unit})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <div className="text-2xl font-bold">
          {def.unit === "USD" ? `${formatNumber(value)}` : `${formatNumber(value)}${suffix}`}
        </div>
      </CardContent>
    </Card>
  );
}

function ShipmentsByStatusDonut({ def, data }: RendererProps) {
  const items = data.shipments || [];
  const counts = items.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const rows = Object.entries(counts).map(([label, value]) => ({ label, value }));
  if (rows.length === 0) return <Card className="shadow-sm h-full"><CardContent><Empty className="flex-1 min-h-36">{`${def.label} — no data`}</Empty></CardContent></Card>;
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>{def.label}</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey="value" nameKey="label" innerRadius={60} outerRadius={90} paddingAngle={2}>
                {rows.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Inventory Tier-A cards ────────────────────────────────────────────────

function InventoryKpiCard({ def, data }: RendererProps) {
  const items = data.inventory || [];
  const d = data.dashboard;
  let value: number | string = 0;
  switch (def.id) {
    case "inv.items.total": value = items.length; break;
    case "inv.lowStock.count": value = items.filter((i) => i.maxQty > 0 && i.currentQty / i.maxQty < 0.2).length; break;
    case "inv.outOfStock": value = items.filter((i) => i.currentQty === 0).length; break;
    case "inv.fillRate": {
      const tot = items.reduce((a, i) => a + i.maxQty, 0);
      value = tot > 0 ? Math.round((items.reduce((a, i) => a + i.currentQty, 0) / tot) * 1000) / 10 : 0;
      break;
    }
    case "inv.seedlots.active": value = d?.activeSeedLots || 0; break;
    case "inv.crops.activeTypes": value = d?.activeCropTypes || 0; break;
    default: value = 0;
  }
  const display = def.unit === "%" ? `${value}%` : formatNumber(value as number);
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="pb-2 space-y-0 shrink-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {def.label}{def.unit && def.unit !== "count" ? ` (${def.unit})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col"><div className="text-2xl font-bold">{display}</div></CardContent>
    </Card>
  );
}

function LowStockListCard({ def, data }: RendererProps) {
  const items = (data.inventory || []).filter((i) => i.maxQty > 0 && i.currentQty / i.maxQty < 0.2);
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between shrink-0">
        <CardTitle>{def.label}</CardTitle>
        {items.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={`Export ${def.label} as CSV`}
            onClick={() => downloadCsv(
              def.id,
              def.label,
              undefined,
              items.map((i) => ({ name: i.name, currentQty: i.currentQty, maxQty: i.maxQty, unit: i.unit })),
            )}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {items.length === 0 ? (
          <Empty className="flex-1 min-h-36">All items above low-stock threshold</Empty>
        ) : (
          <div className="flex-1 divide-y divide-border rounded-md border overflow-hidden overflow-y-auto min-h-0">
            {items.map((i) => (
              <div key={i.id} className="flex items-center justify-between p-3 text-sm">
                <span className="font-medium">{i.name}</span>
                <span className="text-destructive text-xs">{formatNumber(i.currentQty)} / {formatNumber(i.maxQty)} {i.unit}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InventoryCategoryDonut({ def, data }: RendererProps) {
  const items = data.inventory || [];
  const counts = items.reduce<Record<string, number>>((acc, i) => {
    const c = i.category || "uncategorized";
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});
  const rows = Object.entries(counts).map(([label, value]) => ({ label, value }));
  if (rows.length === 0) return <Card className="shadow-sm h-full"><CardContent><Empty className="flex-1 min-h-36">{`${def.label} — no data`}</Empty></CardContent></Card>;
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="shrink-0"><CardTitle>{def.label}</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-56">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey="value" nameKey="label" innerRadius={60} outerRadius={90} paddingAngle={2}>
                {rows.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ActiveSeedLotsTableCard({ def, data }: RendererProps) {
  const rows = (data.dashboard as { activeSeedLotDetails?: { id: number; seedName: string; qrCode: string }[] })?.activeSeedLotDetails || [];
  return (
    <Card className="shadow-sm h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between shrink-0">
        <CardTitle>{def.label}</CardTitle>
        {rows.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={`Export ${def.label} as CSV`}
            onClick={() => downloadCsv(
              def.id,
              def.label,
              undefined,
              rows.map((r) => ({ qrCode: r.qrCode, seedName: r.seedName, status: "Growing" })),
            )}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {rows.length === 0 ? (
          <Empty className="flex-1 min-h-36">No active seed lots</Empty>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr><th className="p-2 text-left">Lot Code</th><th className="p-2 text-left">Crop Name</th><th className="p-2 text-left">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-2 font-mono text-xs">{r.qrCode}</td>
                    <td className="p-2">{r.seedName}</td>
                    <td className="p-2"><Badge variant="secondary">Growing</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Registry of custom renderers (by metric id) ───────────────────────────

const RENDERERS: Record<string, React.ComponentType<RendererProps>> = {
  "ov.yield.week": YieldWeekCard,
  "ov.cycles.active": ActiveCyclesCard,
  "ov.cap.utilization": ChannelUtilKpiCard,
  "ov.bad.count7d": BadTraysCard,
  "ov.seedlots.active": ActiveSeedLotsCard,
  "ov.alerts.active": AlertsActionCard,
  "ov.cycles.actionNeeded": CyclesActionNeededCard,
  "ov.yield.byWeek": YieldByWeekChart,
  "ov.combined.dailyYieldSeeding": DailyYieldSeedingChart,
  "ov.combined.trend7d": Trend7dChart,
  "ov.cap.utilizationChart": ChannelUtilProgressCard,
  "ov.cycles.actionRequiredList": ActionRequiredListCard,
};

/** Resolve a renderer for a metric: custom by id, else generic by source/render. */
export function resolveRenderer(def: MetricDef): React.ComponentType<RendererProps> {
  if (RENDERERS[def.id]) return RENDERERS[def.id];
  if (def.source === "shipments") {
    if (def.render === "donut") return ShipmentsByStatusDonut;
    return ShipmentsKpiCard;
  }
  if (def.source === "inventory") {
    if (def.id === "inv.lowStock.list") return LowStockListCard;
    if (def.id === "inv.byCategory.count") return InventoryCategoryDonut;
    if (def.id === "inv.seedlots.details") return ActiveSeedLotsTableCard;
    return InventoryKpiCard;
  }
  // dashboard Tier-A
  if (def.render === "area" || def.render === "bar" || def.render === "line") {
    return GenericSeriesChart;
  }
  return GenericKpiCard;
}
