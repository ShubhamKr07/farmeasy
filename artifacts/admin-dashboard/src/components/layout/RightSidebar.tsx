import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDashboard,
  useListAlerts,
  useHealthCheck,
  getGetDashboardQueryKey,
  getListAlertsQueryKey,
  getHealthCheckQueryKey,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  CheckCircle2,
  Activity,
  Droplets,
  Thermometer,
  Wind,
  Bell,
  Wifi,
  WifiOff,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { usePanel } from "@/context/PanelContext";
import { QueryError } from "@/components/ui/query-error";
import { FRESHNESS_MS, formatRelativeTime, isStale } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { useRightPanelCollapsed } from "@/hooks/use-right-panel-collapsed";
import { a11yClick } from "@/lib/utils";

export function RightSidebar() {
  const now = useNow(15_000);
  const [collapsed, setCollapsed] = useRightPanelCollapsed();
  const queryClient = useQueryClient();
  const { open } = usePanel();

  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000, staleTime: 15_000 },
  });
  const {
    data: dashboard,
    isLoading: isLoadingDashboard,
    isError: isErrorDashboard,
    refetch: refetchDashboard,
    dataUpdatedAt,
  } = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: FRESHNESS_MS.sensor } });
  const {
    data: alerts,
    isLoading: isLoadingAlerts,
    isError: isErrorAlerts,
    refetch: refetchAlerts,
  } = useListAlerts(
    { status: "current", limit: 2 },
    { query: { queryKey: getListAlertsQueryKey({ status: "current", limit: 2 }), refetchInterval: FRESHNESS_MS.alerts } },
  );

  const sensorStale = isStale(dataUpdatedAt, now, FRESHNESS_MS.sensor);
  const alertCount = alerts?.length ?? 0;
  const hasCritical = alerts?.some((a) => a.severity === "critical") ?? false;
  const dbConnected = !health.isError && health.data?.status === "ok";

  const refreshAll = () => queryClient.invalidateQueries();

  return (
    <aside
      className={`relative border-l bg-background hidden xl:flex flex-col flex-shrink-0 min-h-[100dvh] transition-[width] duration-200 ${
        collapsed ? "w-14" : "w-[280px]"
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        data-testid="button-toggle-right-panel"
        className="absolute -left-3 top-6 z-10 h-6 w-6 rounded-full border bg-background shadow-sm flex items-center justify-center hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {collapsed ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>

      {/* Compact status row — always visible, collapsed or not. */}
      <div className={`flex items-center gap-3 p-4 border-b ${collapsed ? "flex-col" : "justify-between"}`}>
        <span title={dbConnected ? "DB connected" : "DB unreachable"} data-testid={dbConnected ? "pill-db-connected" : "pill-db-unreachable"}>
          {dbConnected ? <Wifi className="h-4 w-4 text-primary" /> : <WifiOff className="h-4 w-4 text-destructive" />}
        </span>
        <button
          type="button"
          className="relative"
          aria-label={`Alerts${alertCount ? ` (${alertCount} open${hasCritical ? ", critical" : ""})` : ""}`}
          onClick={() => open("alerts")}
          data-testid="button-alerts-bell-panel"
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {alertCount > 0 && (
            <span
              className={`absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-0.5 rounded-full text-xs font-bold leading-[16px] text-center text-white ${
                hasCritical ? "bg-destructive" : "bg-primary"
              }`}
            >
              {alertCount > 9 ? "9+" : alertCount}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-label="Open command palette (⌘K)"
          onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
          data-testid="button-command-palette-panel"
        >
          <Search className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {collapsed ? (
        <div className="flex-1" />
      ) : (
        <>
          <div className="p-4 flex flex-col gap-3 border-b">
            {isLoadingDashboard ? (
              <div className="space-y-3">
                <Skeleton className="h-14 w-full" />
              </div>
            ) : isErrorDashboard ? (
              <QueryError resource="sensor status" onRetry={() => refetchDashboard()} />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5" />
                    Sensors
                  </span>
                  <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-xs">
                    {dashboard?.sensorStatus?.sensorsOnline ?? "—"} / {dashboard?.sensorStatus?.sensorsTotal ?? "—"}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Card className="shadow-none border-border/50 bg-muted/30">
                    <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
                      <Droplets className="h-3.5 w-3.5 text-primary mb-1" />
                      <span className="text-xs text-muted-foreground">pH</span>
                      <span className="font-semibold text-sm">{dashboard?.sensorStatus?.acidityPh ?? "—"}</span>
                    </CardContent>
                  </Card>
                  <Card className="shadow-none border-border/50 bg-muted/30">
                    <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
                      <Droplets className="h-3.5 w-3.5 text-primary mb-1" />
                      <span className="text-xs text-muted-foreground">Water</span>
                      <span className="font-semibold text-sm">{dashboard?.sensorStatus?.waterLevelPct != null ? `${dashboard.sensorStatus.waterLevelPct}%` : "—"}</span>
                    </CardContent>
                  </Card>
                  <Card className="shadow-none border-border/50 bg-muted/30">
                    <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
                      <Thermometer className="h-3.5 w-3.5 text-primary mb-1" />
                      <span className="text-xs text-muted-foreground">Temp</span>
                      <span className="font-semibold text-sm">{dashboard?.sensorStatus?.tempCelsius != null ? `${dashboard.sensorStatus.tempCelsius}°C` : "—"}</span>
                    </CardContent>
                  </Card>
                  <Card className="shadow-none border-border/50 bg-muted/30">
                    <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
                      <Wind className="h-3.5 w-3.5 text-primary mb-1" />
                      <span className="text-xs text-muted-foreground">Humidity</span>
                      <span className="font-semibold text-sm">{dashboard?.sensorStatus?.humidityPct != null ? `${dashboard.sensorStatus.humidityPct}%` : "—"}</span>
                    </CardContent>
                  </Card>
                </div>
                <p className="text-xs text-muted-foreground text-right">
                  {sensorStale ? "Readings may be out of date" : `Last reading ${formatRelativeTime(dataUpdatedAt, now)}`}
                </p>
              </>
            )}
          </div>

          <div className="p-4 flex-1 overflow-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-xs flex items-center gap-1.5 text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5" />
                Recent Alerts
              </h3>
            </div>

            <div className="flex flex-col gap-2.5">
              {isLoadingAlerts ? (
                <>
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </>
              ) : isErrorAlerts ? (
                <QueryError resource="alerts" onRetry={() => refetchAlerts()} />
              ) : alerts?.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-6 text-muted-foreground">
                  <CheckCircle2 className="h-7 w-7 mb-2 text-primary/40" />
                  <p className="text-sm">No active alerts</p>
                </div>
              ) : (
                alerts?.map(alert => (
                  <Card
                    key={alert.id}
                    className="shadow-none border-border/50 cursor-pointer hover:border-destructive/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    {...a11yClick(() => open("alerts"))}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start gap-2 mb-2">
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${alert.severity === 'critical' ? 'bg-destructive' : 'bg-status-warn'}`} />
                        <div>
                          <h4 className="text-sm font-semibold leading-tight">{alert.title}</h4>
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{alert.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
                        <span className="text-xs text-muted-foreground uppercase">{alert.location || 'System'}</span>
                        <span className="text-xs text-primary">View all →</span>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Footer icon strip — account/system chrome, kept out of the way. */}
      <div className={`p-2 border-t flex items-center ${collapsed ? "flex-col gap-1" : "justify-between"}`}>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="Refresh data"
          onClick={refreshAll}
          data-testid="button-refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </aside>
  );
}
