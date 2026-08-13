import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useHealthCheck,
  useListAlerts,
  getHealthCheckQueryKey,
  getListAlertsQueryKey,
} from "@workspace/api-client-react";
import { Bell, Menu, RefreshCw, Wifi, WifiOff, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanel } from "@/context/PanelContext";
import { AskMe } from "@/components/ask-me/AskMe";
import { FacilitySwitcher } from "./FacilitySwitcher";
import { MobileNav } from "./MobileNav";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { FRESHNESS_MS } from "@/lib/format";

/**
 * On xl+ screens, RightSidebar carries the alert bell, DB status, search,
 * refresh, theme toggle, and user menu — TopBar is Ask-Me-first (brand mark
 * + the persistent question bar), nothing else competing for attention.
 * Below xl, RightSidebar doesn't render at all, so this same icon group
 * stays in TopBar for mobile/tablet — losing alert access on mobile isn't an
 * option (P0-4).
 */
export function TopBar() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { open } = usePanel();
  const queryClient = useQueryClient();

  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000, staleTime: 15_000 },
  });

  const alerts = useListAlerts(
    { status: "current", limit: 50 },
    { query: { queryKey: getListAlertsQueryKey({ status: "current", limit: 50 }), refetchInterval: FRESHNESS_MS.alerts } },
  );

  const alertCount = alerts.data?.length ?? 0;
  const hasCritical = alerts.data?.some((a) => a.severity === "critical") ?? false;

  const refreshAll = () => {
    queryClient.invalidateQueries();
  };

  return (
    <>
      <header className="h-16 border-b bg-background flex items-center gap-3 px-4 md:px-6 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-10 w-10 shrink-0"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
          data-testid="button-mobile-nav"
        >
          <Menu className="h-5 w-5" />
        </Button>

        <img src="/logo-mark.svg" alt="FarmSmart" className="h-8 w-8 shrink-0 md:hidden" />

        <AskMe />

        <FacilitySwitcher />

        {/* Mobile/tablet only — RightSidebar (xl+) carries these on desktop. */}
        <div className="flex items-center gap-1 xl:hidden shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="relative h-10 w-10"
            aria-label={`Alerts${alertCount ? ` (${alertCount} open${hasCritical ? ", critical" : ""})` : ""}`}
            onClick={() => open("alerts")}
            data-testid="button-alerts-bell"
          >
            <Bell className="h-5 w-5" />
            {alertCount > 0 && (
              <span
                className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold leading-[18px] text-center text-white ${
                  hasCritical ? "bg-destructive" : "bg-primary"
                }`}
                data-testid="badge-alert-count"
              >
                {alertCount > 99 ? "99+" : alertCount}
              </span>
            )}
          </Button>

          {health.isLoading ? (
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
          ) : health.isError || health.data?.status !== "ok" ? (
            <span title="DB unreachable" data-testid="pill-db-unreachable">
              <WifiOff className="h-4 w-4 text-destructive" />
            </span>
          ) : (
            <span title="DB connected" data-testid="pill-db-connected">
              <Wifi className="h-4 w-4 text-primary" />
            </span>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10"
            aria-label="Refresh data"
            onClick={refreshAll}
            data-testid="button-refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-muted-foreground"
            onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
            aria-label="Open command palette (⌘K)"
            data-testid="button-command-palette"
          >
            <Search className="h-4 w-4" />
          </Button>

          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />
    </>
  );
}
