import { useState } from "react";
import { useGetDashboard, useListAlerts } from "@workspace/api-client-react";
import { getMetricDef } from "@workspace/metrics";
import { useMetricSelection } from "@/hooks/use-metric-selection";
import { MetricPicker } from "@/components/metrics/MetricPicker";
import { DraggableMetricGrid } from "@/components/metrics/DraggableMetricGrid";
import { FarmReadinessCard } from "@/components/dashboard/FarmReadinessCard";
import { MetricCard } from "@/components/metrics/MetricCard";
import { TimeRangeSelector, type MetricRange } from "@/components/metrics/TimeRangeSelector";
import type { MetricDataMap } from "@/components/metrics/renderers";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/ui/query-error";

export function Overview() {
  const { data: dashboard, isLoading, isError, refetch } = useGetDashboard();
  const { data: alerts } = useListAlerts({ status: "current", limit: 3 });
  const { selected, selectable, toggle, reorder, reset } = useMetricSelection("overview");
  const [range, setRange] = useState<MetricRange>("30d");

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <QueryError resource="the dashboard" onRetry={() => refetch()} />
      </div>
    );
  }

  const data: MetricDataMap = { dashboard, alerts };

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
        <div className="flex items-center gap-2">
          <TimeRangeSelector range={range} onChange={setRange} />
          <MetricPicker
            tab="overview"
            selectable={selectable}
            selected={selected}
            onToggle={toggle}
            onReset={reset}
          />
        </div>
      </div>

      <FarmReadinessCard mode="dashboard" />

      <DraggableMetricGrid
        ids={selected}
        onReorder={reorder}
        renderItem={(id) => {
          const def = getMetricDef(id);
          if (!def) return null;
          return <MetricCard def={def} data={data} range={range} />;
        }}
      />
    </div>
  );
}
