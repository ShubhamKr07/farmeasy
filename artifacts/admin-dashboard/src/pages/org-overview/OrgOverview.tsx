import { useGetOrgSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/ui/query-error";
import { formatNumber } from "@/lib/format";
import { useOrgRole } from "@/hooks/use-org-role";
import { Building2, Sprout, AlertTriangle, Globe } from "lucide-react";

/**
 * TEN-009 — Org Overview stub: an owner/admin, org-scoped rollup of
 * facilityCount / activeCycles / openAlerts (GET /org/summary). Deliberately
 * minimal — real org analytics (trends, per-facility breakdown) are a future
 * initiative; this is the scaffolding + org-scoped read pattern.
 *
 * Page-level role check mirrors the nav-entry gate (Sidebar/MobileNav) for
 * defense-in-depth on direct navigation to /org — the server-side
 * `requireRole("owner","admin")` 403 remains the real access control; this is
 * purely the directing UX, same pattern as App.tsx's TechnicianDeniedScreen.
 */
export function OrgOverview() {
  const { role, loading: roleLoading } = useOrgRole();
  const { data, isLoading, isError, refetch } = useGetOrgSummary();

  if (roleLoading) {
    return (
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (role !== "owner" && role !== "admin") {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="flex flex-col items-center justify-center gap-3 text-center py-16 text-muted-foreground">
          <Globe className="h-8 w-8" />
          <p>Org Overview is available to owners and admins only.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <QueryError resource="the org summary" onRetry={() => refetch()} />
      </div>
    );
  }

  const summary = data ?? { facilityCount: 0, activeCycles: 0, openAlerts: 0 };

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Org Overview</h1>
        <p className="text-sm text-muted-foreground">
          A high-level rollup across every facility in your organization.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Facilities</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{formatNumber(summary.facilityCount)}</div>
            <p className="text-xs text-muted-foreground mt-1">Facilities in this organization</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Cycles</CardTitle>
            <Sprout className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{formatNumber(summary.activeCycles)}</div>
            <p className="text-xs text-muted-foreground mt-1">Running across all facilities</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Alerts</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{formatNumber(summary.openAlerts)}</div>
            <p className="text-xs text-muted-foreground mt-1">Current alerts org-wide</p>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground">
          More org analytics coming soon — trends, per-facility breakdowns, and yield/throughput
          comparisons across your organization.
        </CardContent>
      </Card>
    </div>
  );
}
