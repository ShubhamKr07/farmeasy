/**
 * Selectable-metrics registry types.
 *
 * Shared by the admin dashboard (picker + cards) and the API server
 * (`/api/metrics` allowlist + query-template dispatch). Source of truth for
 * the metric catalog; see docs/metrics-data-dictionary.md.
 */

export type MetricTab = "overview" | "shipments" | "inventory" | "accounting";

export type MetricRender =
  | "kpi"
  | "stat"
  | "progress"
  | "area"
  | "bar"
  | "hbar"
  | "line"
  | "donut"
  | "stacked"
  | "table"
  | "list"
  | "gauge"
  | "scatter"
  | "heatmap";

/**
 * Where the card's data comes from.
 * - `dashboard` / `alerts` / `shipments` / `inventory`: Tier A — derived
 *   client-side from the existing list/dashboard payloads (M1).
 * - `metrics`: Tier B — served by `GET /api/metrics` (M2+). Every accounting
 *   metric is Tier B (`template: "quickbooks"`) — there's no local Postgres
 *   data source for QuickBooks figures.
 */
export type MetricSource =
  | "dashboard"
  | "alerts"
  | "shipments"
  | "inventory"
  | "metrics";

export type MetricWindow = "7d" | "30d" | "90d" | "range" | "all";

export type MetricTemplate =
  | "scalarAgg"
  | "groupBy"
  | "timeBucket"
  | "ratio"
  | "table"
  | "custom"
  | "quickbooks";

export type MetricUnit =
  | "kg"
  | "g"
  | "USD"
  | "days"
  | "%"
  | "count"
  | "USD/kg"
  | "";

export interface MetricDef {
  id: string;
  tab: MetricTab;
  label: string;
  category: string;
  description: string;
  unit: MetricUnit;
  window?: MetricWindow;
  render: MetricRender;
  /** Server metric key returned by /api/metrics (Tier B) or the client resolver key (Tier A). */
  dataKey: string;
  source: MetricSource;
  defaultSelected: boolean;
  /** Availability gates resolved server-side via /api/metrics/availability. */
  requires?: string[];
  /** Tier-B query shape; Tier-A entries omit (filled when migrated). */
  template?: MetricTemplate;
  templateParams?: Record<string, string | number>;
  /** For `template:"table"` metrics: return at most N rows (LIMIT, no cursor). */
  topN?: number;
  /** Link to a paginated resource view for list/table cards (full list lives on a resource endpoint). */
  resourceLink?: string;
  /** Preserves the existing data-testid during the M1 refactor. */
  testId?: string;
  /** Open this PanelContext panel when the card is clicked. */
  panel?: string;
  /** Grid column span on lg (4-col). Defaults by `render`: KPI/stat/gauge/progress=1, others=2. */
  span?: 1 | 2 | 4;
  /**
   * Row-height class for the overview grid height contract (OVW-001/002).
   * - `compact` (default): one-line KPI/stat cards — short, uniform row.
   * - `tall`: chart cards (trend/series) that need vertical room; the CSS grid
   *   uses `grid-auto-rows` + `h-full` on card roots so every card in a row
   *   stretches to that row's tallest member.
   * DraggableMetricGrid reads this to lay out rows; a CI check bans fixed
   * pixel heights (`h-[…px]`) from metric components so the contract holds.
   */
  size?: "compact" | "tall";
}
