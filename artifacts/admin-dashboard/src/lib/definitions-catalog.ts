// artifacts/admin-dashboard/src/lib/definitions-catalog.ts
//
// KPI definition catalog (HLP-001/002, Task 7).
//
// One DefinitionEntry per Overview KPI/stat metric — the rich tooltip text
// shown when an operator hovers/focuses the ⓘ icon next to a metric title.
// The registry's terse `description` (one line, written for the picker) is
// intentionally separate from this catalog: here we state the *formula* and
// the *exact time window* in plain language so two operators reading the same
// card compute the same number.
//
// Coverage is enforced in CI by scripts/ci/check-metric-definitions.mjs: every
// metric in lib/metrics/src/registry-overview.ts with render "kpi" or "stat"
// MUST have an entry here, or the build fails. Missing an entry must never
// render as a silently-empty tooltip (the tooltip component renders an explicit
// "definition unavailable" fallback, and CI prevents it from ever shipping).
//
// Window text is explicit and human-readable ("rolling 7 days ending today",
// "facility-local week starting Monday"), never the raw token ("7d"). It is
// resolved from the same constants the backend uses — the facility timezone
// (`FACILITY_TIMEZONE`, default America/New_York) and the facility-local
// Monday-start week (rule 1, docs/metrics-data-dictionary.md §1.5) — so the
// tooltip states exactly what the query did. See WINDOW_*/TZ_* constants below.

/**
 * Resolved-window constants. The backend computes windows in the
 * facility-local timezone (`FACILITY_TIMEZONE`, default America/New_York;
 * see docs/metrics-data-dictionary.md §1.5 rule 1). These strings name that
 * resolution in plain language so the tooltip restates the query's window
 * verbatim instead of leaking the raw `7d` token.
 *
 * TODAY  — the facility-local "now" used for staleness / rolling windows.
 * WEEK_START — facility-local Monday-start ISO week (rule 1).
 * MONTH_START — facility-local first-of-month.
 */
export const FACILITY_TZ_LABEL = "facility timezone (FACILITY_TIMEZONE, default America/New_York)";
export const WINDOW_TODAY = "as of the facility-local current time (now() in the facility timezone)";
export const WINDOW_WEEK = "facility-local week starting Monday (ISO) through the facility-local current time";
export const WINDOW_MONTH = "facility-local calendar month (1st through the facility-local current time)";
export const WINDOW_ROLLING_7D = "rolling 7 days ending at the facility-local current time";
export const WINDOW_ROLLING_30D = "rolling 30 days ending at the facility-local current time";
export const WINDOW_90D_COHORT = "cycles seeded in the last 90 days (rolling, facility-local), whose growth-profile duration has elapsed";
export const WINDOW_ALLTIME = "all-time (no window; full history excluding soft-deleted rows)";
export const WINDOW_LATEST_READING = "the single latest reading per sensor (no window; staleness contract: stale past 2 min)";

/** A catalog entry — the three tooltip lines + lookup id. */
export interface DefinitionEntry {
  /** MetricDef.id this entry describes (e.g. "ov.cycles.active"). */
  id: string;
  /** Display term (line 1, bold). */
  term: string;
  /**
   * Plain-language definition of what the number counts. Shown as line 1's
   * sub-text (after the bold term). States the source table/field where
   * useful ("Source: harvest records").
   */
  definition: string;
  /**
   * Formula / source attribution (line 2). The computation in words — e.g.
   * "SUM(cycles.harvested_qty) where status='completed'". Includes a
   * "Source: <table>" attribution so an operator can trace the figure.
   */
  formula: string;
  /**
   * Explicit, resolved time window (line 3). Never the raw token ("7d") —
   * always a plain-language phrase resolved from WINDOW_* + the facility tz.
   * "all-time" for unwindowed metrics.
   */
  window: string;
}

/**
 * The catalog. Keyed by MetricDef.id. Add new KPI/stat metrics here in the
 * same PR that adds them to registry-overview.ts — CI fails otherwise.
 */
export const DEFINITIONS_CATALOG: Record<string, DefinitionEntry> = {
  // ── Yield / production ─────────────────────────────────────────────────
  "ov.yield.week": {
    id: "ov.yield.week",
    term: "Total Yield (Week)",
    definition: "Total harvested weight from cycles that closed this week. Source: harvest records (cycles.harvested_qty).",
    formula: "SUM(cycles.harvested_qty) where status='completed' AND closed_at >= weekStart, excluding soft-deleted cycles.",
    window: WINDOW_WEEK + ".",
  },
  "ov.yield.month": {
    id: "ov.yield.month",
    term: "Total Yield (Month)",
    definition: "Total harvested weight from cycles that closed this month. Source: harvest records (cycles.harvested_qty).",
    formula: "SUM(cycles.harvested_qty) where status='completed' AND closed_at >= monthStart, excluding soft-deleted cycles.",
    window: WINDOW_MONTH + ".",
  },
  "ov.yield.alltime": {
    id: "ov.yield.alltime",
    term: "Total Yield (All-time)",
    definition: "Lifetime harvested weight across every completed cycle. Source: harvest records (cycles.harvested_qty).",
    formula: "SUM(cycles.harvested_qty) where status='completed' AND deleted_at IS NULL.",
    window: WINDOW_ALLTIME + ".",
  },
  "ov.yield.avgPerCycle": {
    id: "ov.yield.avgPerCycle",
    term: "Avg Yield / Cycle",
    definition: "Average harvested weight per completed cycle. Source: harvest records (cycles.harvested_qty).",
    formula: "SUM(cycles.harvested_qty) / COUNT(cycles) where status='completed' AND deleted_at IS NULL.",
    window: WINDOW_ALLTIME + ".",
  },
  "ov.yield.avgPerTray": {
    id: "ov.yield.avgPerTray",
    term: "Avg Yield / Tray",
    definition: "Average harvested weight per full-tray-equivalent across all cycles. Source: harvest records + tray counts.",
    formula: "SUM(cycles.harvested_qty) / SUM(cycles.full_trays + cycles.half_trays * 0.5), excluding soft-deleted cycles.",
    window: WINDOW_ALLTIME + ".",
  },
  "ov.yield.forecast": {
    id: "ov.yield.forecast",
    term: "Upcoming Harvest (est)",
    definition: "Estimated harvest weight still to come from non-completed cycles, using each growth profile's expected yield per tray. Source: growth_profiles.expected_yield_per_tray_kg.",
    formula: "SUM(growth_profiles.expected_yield_per_tray_kg * (cycles.full_trays + cycles.half_trays*0.5)) for cycles where status<>'completed' AND deleted_at IS NULL AND expected_yield_per_tray_kg IS NOT NULL.",
    window: WINDOW_ALLTIME + " (forward-looking estimate, not a commitment).",
  },

  // ── Cycles / activity ──────────────────────────────────────────────────
  "ov.cycles.active": {
    id: "ov.cycles.active",
    term: "Active Cycles",
    definition: "Number of grow cycles currently in progress (any status other than completed). Source: cycles table.",
    formula: "COUNT(cycles) where status <> 'completed' AND deleted_at IS NULL.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.cycles.actionNeeded": {
    id: "ov.cycles.actionNeeded",
    term: "Cycles Needing Action",
    definition: "Cycles whose next stage transition is overdue (past their growth-profile target). Source: dashboard.actionRequired (daysOverdue > 0).",
    formula: "COUNT(cycles) where daysOverdue > 0, derived from the growth-profile stage targets vs. actual stage-start timestamps.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.cycles.avgDuration": {
    id: "ov.cycles.avgDuration",
    term: "Avg Cycle Duration",
    definition: "Mean elapsed time from seeding to close, across completed cycles. Source: cycles.seeding_date + cycles.closed_at.",
    formula: "AVG(closed_at - seeding_date) in days, where status='completed' AND deleted_at IS NULL.",
    window: WINDOW_ALLTIME + ".",
  },
  "ov.cycles.overdue": {
    id: "ov.cycles.overdue",
    term: "Overdue Cycles",
    definition: "Cycles with an overdue stage transition. Source: dashboard.actionRequired (daysOverdue > 0).",
    formula: "COUNT(cycles) where daysOverdue > 0 (same population as 'Cycles Needing Action').",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.cycles.completionRate": {
    id: "ov.cycles.completionRate",
    term: "Completion Rate (90d cohort)",
    definition: "Share of a recent seeding cohort that has completed its grow cycle. Source: cycles (cohort rule 6, data dictionary §1.5).",
    formula: "completed cycles / cycles seeded in the window whose growth-profile duration has since elapsed (numerator and denominator share the same window + cohort).",
    window: WINDOW_90D_COHORT + ".",
  },

  // ── Capacity / trays ───────────────────────────────────────────────────
  "ov.cap.utilization": {
    id: "ov.cap.utilization",
    term: "Channel Utilization",
    definition: "Share of grow channels currently occupied by a running cycle. Source: cycles.tray_id → trays → racks → channels.",
    formula: "(running cycles' channels) / (total channels). 'Running' = cycles with status <> 'completed'.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.cap.activeTrays": {
    id: "ov.cap.activeTrays",
    term: "Active Trays",
    definition: "Full-tray-equivalents currently in a running cycle. Source: cycles.full_trays + cycles.half_trays.",
    formula: "SUM(cycles.full_trays + cycles.half_trays * 0.5) where status <> 'completed' AND deleted_at IS NULL.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },

  // ── Bad trays / loss ───────────────────────────────────────────────────
  "ov.bad.count7d": {
    id: "ov.bad.count7d",
    term: "Bad Trays",
    definition: "Trays flagged as bad/lost this week. Source: bad_tray_entries after the cutover date, manual_checks legacy rows before (rule 4).",
    formula: "COUNT(bad-tray records created this week), UNIONing bad_tray_entries (post-cutover) with legacy manual_checks.is_bad_trays rows (pre-cutover) — never both over the same range.",
    window: WINDOW_WEEK + ".",
  },
  "ov.bad.lossEstimate": {
    id: "ov.bad.lossEstimate",
    term: "Loss Estimate",
    definition: "Estimated dollar value lost to bad trays. Source: bad_tray_entries.loss_estimate (USD; verify existing rows before trusting sums).",
    formula: "SUM(bad_tray_entries.loss_estimate) where created_at >= BAD_TRAYS_CUTOVER_DATE.",
    window: WINDOW_ALLTIME + " (post-cutover rows only).",
  },
  "ov.bad.rate": {
    id: "ov.bad.rate",
    term: "Bad-Tray Rate (30d)",
    definition: "Share of seeded trays that turned bad over the window. Source: bad_tray_entries + cycles tray counts (rate denominator rule 6).",
    formula: "(bad trays in window) / (trays seeded in window) — numerator and denominator share the same window + cohort.",
    window: WINDOW_ROLLING_30D + ".",
  },

  // ── Sensors / environment ──────────────────────────────────────────────
  "ov.sensor.currentTemp": {
    id: "ov.sensor.currentTemp",
    term: "Current Temp",
    definition: "Latest temperature reading. Source: latest sensor_readings row per temp sensor (rule 5; sensor_status snapshot is deprecated).",
    formula: "latest sensor_readings.value for type='temp', returned with its read_at timestamp; stale past 2 min per the staleness contract.",
    window: WINDOW_LATEST_READING + ".",
  },
  "ov.sensor.currentPh": {
    id: "ov.sensor.currentPh",
    term: "Current pH",
    definition: "Latest pH reading. Source: latest sensor_readings row per pH sensor (rule 5).",
    formula: "latest sensor_readings.value for type='ph', returned with its read_at timestamp; stale past 2 min per the staleness contract.",
    window: WINDOW_LATEST_READING + ".",
  },
  "ov.sensor.currentHumidity": {
    id: "ov.sensor.currentHumidity",
    term: "Current Humidity",
    definition: "Latest relative-humidity reading. Source: latest sensor_readings row per humidity sensor (rule 5).",
    formula: "latest sensor_readings.value for type='humidity', returned with its read_at timestamp; stale past 2 min per the staleness contract.",
    window: WINDOW_LATEST_READING + ".",
  },
  "ov.sensor.currentWater": {
    id: "ov.sensor.currentWater",
    term: "Current Water Level",
    definition: "Latest water-level reading. Source: latest sensor_readings row per water sensor (rule 5).",
    formula: "latest sensor_readings.value for type='water', returned with its read_at timestamp; stale past 2 min per the staleness contract.",
    window: WINDOW_LATEST_READING + ".",
  },
  "ov.sensor.outOfRange": {
    id: "ov.sensor.outOfRange",
    term: "Out-of-Range Events",
    definition: "Readings that fell outside the linked growth profile's pH/temp bounds. Source: sensor_readings matched to growth_profiles.",
    formula: "COUNT(sensor_readings outside growth_profile ph/temp bounds), matched per-sensor to a profile (deferred — needs per-sensor profile matching).",
    window: WINDOW_LATEST_READING + " over the selected range.",
  },
  "ov.sensor.uptime": {
    id: "ov.sensor.uptime",
    term: "Sensor Uptime",
    definition: "Share of sensors with a fresh reading. Source: sensors.last_read_at vs. the staleness contract.",
    formula: "(sensors with last_read_at within the last 2 minutes) / (total sensors).",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },

  // ── Alerts ─────────────────────────────────────────────────────────────
  "ov.alerts.active": {
    id: "ov.alerts.active",
    term: "Alerts Requiring Action",
    definition: "Alerts that are currently open and need operator attention. Source: alerts where status='current'.",
    formula: "COUNT(alerts) where status='current'.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.alerts.critical": {
    id: "ov.alerts.critical",
    term: "Critical Alerts",
    definition: "Currently-open alerts flagged critical severity. Source: alerts where status='current' AND severity='critical'.",
    formula: "COUNT(alerts) where status='current' AND severity='critical'.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.alerts.mttr": {
    id: "ov.alerts.mttr",
    term: "Mean Time to Resolve",
    definition: "Average time from alert creation to resolution, across resolved alerts. Source: alerts.created_at + alerts.resolved_at.",
    formula: "AVG(resolved_at - created_at) in days, where status='resolved'.",
    window: WINDOW_ALLTIME + ".",
  },
  "ov.alerts.resolved7d": {
    id: "ov.alerts.resolved7d",
    term: "Resolved (7d)",
    definition: "Alerts resolved in the last week. Source: alerts.resolved_at.",
    formula: "COUNT(alerts) where status='resolved' AND resolved_at >= weekStart.",
    window: WINDOW_WEEK + ".",
  },

  // ── Tasks ──────────────────────────────────────────────────────────────
  "ov.tasks.open": {
    id: "ov.tasks.open",
    term: "Open Tasks",
    definition: "Tasks not yet done. Source: tasks table.",
    formula: "COUNT(tasks) where status <> 'done'.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.tasks.overdue": {
    id: "ov.tasks.overdue",
    term: "Overdue Tasks",
    definition: "Tasks past their due date that aren't done yet. Source: tasks.due_at.",
    formula: "COUNT(tasks) where due_at < now() AND status <> 'done'.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.tasks.completionRate": {
    id: "ov.tasks.completionRate",
    term: "Task Completion Rate",
    definition: "Share of all tasks that are done. Source: tasks.status.",
    formula: "COUNT(tasks where status='done') / COUNT(tasks) (rate denominator rule 6).",
    window: WINDOW_ALLTIME + ".",
  },

  // ── Seed lots / crops ──────────────────────────────────────────────────
  "ov.seedlots.active": {
    id: "ov.seedlots.active",
    term: "Active Seed Lots",
    definition: "Seed lots currently in rotation (being grown). Source: seed_lots.currently_grown.",
    formula: "COUNT(seed_lots) where currently_grown = true.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },
  "ov.crops.activeTypes": {
    id: "ov.crops.activeTypes",
    term: "Active Crop Types",
    definition: "Number of distinct crop types currently being grown. Source: cycles → growth_profiles.crop_id (crop grouping rule 7).",
    formula: "COUNT(DISTINCT growth_profiles.crop_id) across running cycles (status <> 'completed'), joined via cycles.growth_profile_id.",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },

  // ── Overview charts (non-kpi, but rendered by Tier-A cards that carry a
  // definition tooltip — entries here keep the tooltip from showing its
  // "definition unavailable" fallback). Not enforced by CI (render != kpi/stat),
  // but kept complete for operator-facing consistency. ────────────────────
  "ov.yield.byWeek": {
    id: "ov.yield.byWeek",
    term: "Yield by Week",
    definition: "Weekly harvested weight, last 4 facility-local weeks. Source: harvest records (cycles.harvested_qty) bucketed by closed_at week.",
    formula: "SUM(cycles.harvested_qty) GROUP BY week (facility-local Monday-start), where status='completed' AND deleted_at IS NULL.",
    window: WINDOW_ROLLING_30D + " (last 4 facility-local weeks).",
  },
  "ov.cap.utilizationChart": {
    id: "ov.cap.utilizationChart",
    term: "Channel Utilization",
    definition: "Running channels vs total, shown as a progress bar. Source: cycles.tray_id → trays → racks → channels.",
    formula: "(running cycles' channels) / (total channels). 'Running' = cycles with status <> 'completed' (same figure as the 'Channel Utilization' KPI).",
    window: WINDOW_TODAY + " (point-in-time snapshot, not windowed).",
  },

  // ── Accounting (QuickBooks; Tier B) ────────────────────────────────────
  // All figures come from the QuickBooks Online Reports/Query APIs
  // (api-server/src/lib/metrics/quickbooks-reports.ts). P&L and Balance
  // Sheet items are summarized for a date range; the window is the QBO
  // report's date range, resolved facility-locally. QuickBooks reports are
  // not time-windowed by a facility-local "now()" snapshot — they cover a
  // declared accounting period (month-to-date, or the balance as of a date).
  "acct.revenue.total": {
    id: "acct.revenue.total",
    term: "Total Revenue",
    definition: "Total income for the period. Source: QuickBooks Profit & Loss report (top-line revenue).",
    formula: "Sum of all income accounts from the QuickBooks Profit & Loss report for the selected period.",
    window: "QuickBooks accounting period — rolling 30 days ending at the facility-local current time.",
  },
  "acct.expenses.total": {
    id: "acct.expenses.total",
    term: "Total Expenses",
    definition: "Total expenses for the period. Source: QuickBooks Profit & Loss report (total expenses line).",
    formula: "Sum of all expense accounts from the QuickBooks Profit & Loss report for the selected period.",
    window: "QuickBooks accounting period — rolling 30 days ending at the facility-local current time.",
  },
  "acct.netIncome": {
    id: "acct.netIncome",
    term: "Net Income",
    definition: "Total revenue minus total expenses for the period. Source: QuickBooks Profit & Loss report (net income line).",
    formula: "Total Revenue − Total Expenses (QuickBooks Profit & Loss, same period).",
    window: "QuickBooks accounting period — rolling 30 days ending at the facility-local current time.",
  },
  "acct.cashBalance": {
    id: "acct.cashBalance",
    term: "Cash Balance",
    definition: "Total cash and bank account balance. Source: QuickBooks Balance Sheet (cash + bank asset accounts).",
    formula: "Sum of cash and bank-account balances from the QuickBooks Balance Sheet.",
    window: "As of the QuickBooks Balance Sheet report date (point-in-time, not a range).",
  },
  "acct.accountsReceivable": {
    id: "acct.accountsReceivable",
    term: "Accounts Receivable",
    definition: "Total outstanding customer invoices. Source: QuickBooks Balance Sheet (A/R asset) / Invoice query.",
    formula: "Sum of open customer invoice balances (QuickBooks Balance Sheet A/R, or the Invoice query outstanding total).",
    window: "As of the QuickBooks Balance Sheet report date (point-in-time, not a range).",
  },
  "acct.accountsPayable": {
    id: "acct.accountsPayable",
    term: "Accounts Payable",
    definition: "Total outstanding vendor bills. Source: QuickBooks Balance Sheet (A/P liability) / Bill query.",
    formula: "Sum of open vendor bill balances (QuickBooks Balance Sheet A/P, or the Bill query outstanding total).",
    window: "As of the QuickBooks Balance Sheet report date (point-in-time, not a range).",
  },
  "acct.currentRatio": {
    id: "acct.currentRatio",
    term: "Current Ratio",
    definition: "Current assets divided by current liabilities. Source: QuickBooks Balance Sheet.",
    formula: "(current assets) / (current liabilities), both from the QuickBooks Balance Sheet.",
    window: "As of the QuickBooks Balance Sheet report date (point-in-time, not a range).",
  },
  "acct.grossProfitMargin": {
    id: "acct.grossProfitMargin",
    term: "Gross Profit Margin",
    definition: "(Revenue − COGS) / Revenue for the period. Source: QuickBooks Profit & Loss report.",
    formula: "(Total Revenue − Cost of Goods Sold) / Total Revenue (QuickBooks Profit & Loss, same period).",
    window: "QuickBooks accounting period — rolling 30 days ending at the facility-local current time.",
  },
};

/**
 * Look up a definition entry by metric id. Returns undefined if no entry
 * exists — callers should render an explicit "definition unavailable"
 * fallback rather than a silently-empty tooltip. CI
 * (scripts/ci/check-metric-definitions.mjs) keeps this from ever returning
 * undefined for a shipped kpi/stat metric.
 */
export function getDefinition(id: string): DefinitionEntry | undefined {
  return DEFINITIONS_CATALOG[id];
}

/**
 * All ids present in the catalog. Used by the CI check to diff against the
 * registry without re-parsing the .ts file by hand (the check imports this
 * list via a tiny static extractor — see scripts/ci/check-metric-definitions.mjs).
 */
export const CATALOG_IDS: readonly string[] = Object.keys(DEFINITIONS_CATALOG);
