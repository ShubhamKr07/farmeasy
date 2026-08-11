import React, { useMemo } from "react";
import { resolveRenderer, type MetricDataMap, type RendererProps } from "./renderers";
import { TierBMetricCard } from "./TierBMetricCard";
import type { MetricRange } from "./TimeRangeSelector";
import type { MetricDef } from "@workspace/metrics";

interface MetricCardProps {
  def: MetricDef;
  data: MetricDataMap;
  range: MetricRange;
  connectionState?: "ok" | "expired" | "error";
  onMetricError?: (error: unknown) => void;
}

/**
 * Renders a metric's card body. The grid span class is applied by the parent
 * grid (MetricGrid / DraggableMetricGrid), not here — this component just
 * returns the card content. Tier-A metrics render from the page's existing
 * data hooks (renderer owns the full Card, preserving today's pixels).
 * Tier-B metrics (source: "metrics" + a query template) render via
 * TierBMetricCard, which fetches /api/metrics.
 */
export function MetricCard({ def, data, range, connectionState, onMetricError }: MetricCardProps) {
  const isTierB = def.source === "metrics" && !!def.template && !!def.templateParams;
  const Renderer = useMemo(() => resolveRenderer(def), [def]);

  if (isTierB) {
    return (
      <TierBMetricCard
        def={def}
        range={range}
        suppressConnectionError={connectionState === "expired"}
        onMetricError={onMetricError}
      />
    );
  }

  const props: RendererProps = { def, data };
  return <Renderer {...props} />;
}
