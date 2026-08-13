import { callWithReactiveRefresh } from "./quickbooks";

/**
 * QuickBooks Online Reports + Query API fetchers, one per accounting metric
 * id (see lib/metrics/src/registry-accounting.ts). Dispatched from
 * routes/metrics.ts via `template: "quickbooks", templateParams: { key }`.
 *
 * Reports API (ProfitAndLoss, BalanceSheet) returns a deeply nested
 * Rows/Columns/ColData tree; the walkers below flatten it into the plain
 * {value} / {label,value}[] shapes the dashboard cards expect — the same
 * contract Tier-B Postgres metrics use, so TierBMetricCard needs no
 * QuickBooks-specific rendering logic.
 */

const QBO_MINOR_VERSION = "65";

function baseUrl(environment: "sandbox" | "production"): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function currentEnvironment(): "sandbox" | "production" {
  return process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
}

interface QboReportRow {
  type?: string;
  group?: string;
  ColData?: { value?: string; id?: string }[];
  Rows?: { Row?: QboReportRow[] };
  Summary?: { ColData?: { value?: string }[] };
  Header?: { ColData?: { value?: string }[] };
}

interface QboReport {
  Rows?: { Row?: QboReportRow[] };
  Header?: { StartPeriod?: string; EndPeriod?: string };
}

async function fetchReport(
  userId: string,
  organizationId: number,
  reportName: "ProfitAndLoss" | "BalanceSheet",
  params: Record<string, string> = {},
): Promise<QboReport> {
  return callWithReactiveRefresh(userId, organizationId, async (client, realmId) => {
    const url = `${baseUrl(currentEnvironment())}/v3/company/${realmId}/reports/${reportName}`;
    const res = await client.makeApiCall({
      url,
      method: "GET",
      params: { minorversion: QBO_MINOR_VERSION, ...params },
    });
    return res.json as QboReport;
  });
}

async function queryQbo(userId: string, organizationId: number, query: string): Promise<any> {
  return callWithReactiveRefresh(userId, organizationId, async (client, realmId) => {
    const url = `${baseUrl(currentEnvironment())}/v3/company/${realmId}/query`;
    const res = await client.makeApiCall({
      url,
      method: "GET",
      params: { query, minorversion: QBO_MINOR_VERSION },
    });
    return res.json;
  });
}

/** Finds the top-level summary row for a given group name (e.g. "Income", "Expenses", "NetIncome") and returns its total. */
function findGroupTotal(rows: QboReportRow[] | undefined, group: string): number {
  if (!rows) return 0;
  for (const row of rows) {
    if (row.group === group) {
      const total = row.Summary?.ColData?.[row.Summary.ColData.length - 1]?.value
        ?? row.ColData?.[row.ColData.length - 1]?.value;
      return Number(total) || 0;
    }
    if (row.Rows?.Row) {
      const nested = findGroupTotal(row.Rows.Row, group);
      if (nested !== 0) return nested;
    }
  }
  return 0;
}

/** Flattens a report's leaf (non-summary) rows under a group into {label,value} pairs — used for "by category" breakdowns. */
function flattenLeafRows(rows: QboReportRow[] | undefined, group: string): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  function walk(list: QboReportRow[] | undefined, inTargetGroup: boolean) {
    if (!list) return;
    for (const row of list) {
      const isTarget = inTargetGroup || row.group === group;
      if (row.type === "Data" && isTarget && row.ColData) {
        const label = row.ColData[0]?.value ?? "(unknown)";
        const value = Number(row.ColData[row.ColData.length - 1]?.value) || 0;
        if (value !== 0) out.push({ label, value });
      }
      if (row.Rows?.Row) walk(row.Rows.Row, isTarget);
    }
  }
  walk(rows, false);
  return out;
}

/**
 * Explicit start/end date params for "last 30 days" — QBO's Reports API
 * `date_macro` only accepts specific enum values (Today, This Month, Last
 * Month, This Fiscal Year, etc.), not an arbitrary "last N days"; explicit
 * start_date/end_date works for any window.
 */
function last30DaysParams(): Record<string, string> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

/** Monthly P&L summarized-by-month report -> {label:"YYYY-MM", value}[] for a given group. */
async function monthlyGroupSeries(userId: string, organizationId: number, group: string): Promise<{ label: string; value: number }[]> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", {
    start_date: start.toISOString().slice(0, 10),
    end_date: now.toISOString().slice(0, 10),
    summarize_column_by: "Month",
  });
  const rows = report.Rows?.Row;
  const target = rows?.find((r) => r.group === group);
  if (!target?.Summary?.ColData) return [];
  // Header row carries the month labels; summary row (skip first "label" col
  // and last "total" col) carries the per-month values.
  const headerCols = (rows?.find((r) => r.type === "Header")?.Header?.ColData ?? []) as { value?: string }[];
  const values = target.Summary.ColData;
  const out: { label: string; value: number }[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const label = headerCols[i]?.value ?? `M${i}`;
    out.push({ label, value: Number(values[i]?.value) || 0 });
  }
  return out;
}

async function acctRevenueTotal(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return { value: findGroupTotal(report.Rows?.Row, "Income") };
}

async function acctExpensesTotal(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return { value: findGroupTotal(report.Rows?.Row, "Expenses") };
}

async function acctNetIncome(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  const income = findGroupTotal(report.Rows?.Row, "Income");
  const expenses = findGroupTotal(report.Rows?.Row, "Expenses");
  return { value: income - expenses };
}

async function acctGrossProfitMargin(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  const income = findGroupTotal(report.Rows?.Row, "Income");
  const cogs = findGroupTotal(report.Rows?.Row, "COGS");
  return { value: income > 0 ? (income - cogs) / income : 0 };
}

async function acctRevenueByMonth(userId: string, organizationId: number) {
  return monthlyGroupSeries(userId, organizationId, "Income");
}

async function acctExpensesByMonth(userId: string, organizationId: number) {
  return monthlyGroupSeries(userId, organizationId, "Expenses");
}

async function acctExpensesByCategory(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return flattenLeafRows(report.Rows?.Row, "Expenses");
}

async function acctCashBalance(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "BankAccounts") };
}

async function acctAccountsReceivable(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "AR") };
}

async function acctAccountsPayable(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "AP") };
}

async function acctCurrentRatio(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  const currentAssets = findGroupTotal(report.Rows?.Row, "TotalCurrentAssets");
  const currentLiabilities = findGroupTotal(report.Rows?.Row, "TotalCurrentLiabilities");
  return { value: currentLiabilities > 0 ? currentAssets / currentLiabilities : 0 };
}

async function acctInvoicesOverdue(userId: string, organizationId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await queryQbo(
    userId,
    organizationId,
    `SELECT Id, DocNumber, CustomerRef, DueDate, Balance, TotalAmt FROM Invoice WHERE Balance > '0' AND DueDate < '${today}' ORDERBY DueDate ASC MAXRESULTS 50`,
  );
  const invoices = result?.QueryResponse?.Invoice ?? [];
  return invoices.map((inv: any) => ({
    docNumber: inv.DocNumber ?? "",
    customer: inv.CustomerRef?.name ?? "",
    dueDate: inv.DueDate ?? "",
    balance: Number(inv.Balance) || 0,
    totalAmt: Number(inv.TotalAmt) || 0,
  }));
}

async function acctInvoicesByStatus(userId: string, organizationId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await queryQbo(userId, organizationId, "SELECT Id, Balance, DueDate FROM Invoice MAXRESULTS 1000");
  const invoices = result?.QueryResponse?.Invoice ?? [];
  let paid = 0, overdue = 0, pending = 0;
  for (const inv of invoices) {
    const balance = Number(inv.Balance) || 0;
    if (balance === 0) paid++;
    else if (inv.DueDate && inv.DueDate < today) overdue++;
    else pending++;
  }
  return [
    { label: "Paid", value: paid },
    { label: "Overdue", value: overdue },
    { label: "Pending", value: pending },
  ];
}

async function acctInvoicesAgingBuckets(userId: string, organizationId: number) {
  const result = await queryQbo(userId, organizationId, "SELECT Id, Balance, DueDate FROM Invoice WHERE Balance > '0' MAXRESULTS 1000");
  const invoices = result?.QueryResponse?.Invoice ?? [];
  const now = Date.now();
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const inv of invoices) {
    const balance = Number(inv.Balance) || 0;
    if (!inv.DueDate) continue;
    const daysOverdue = Math.floor((now - new Date(inv.DueDate).getTime()) / 86_400_000);
    if (daysOverdue <= 30) buckets["0-30"] += balance;
    else if (daysOverdue <= 60) buckets["31-60"] += balance;
    else if (daysOverdue <= 90) buckets["61-90"] += balance;
    else buckets["90+"] += balance;
  }
  return Object.entries(buckets).map(([label, value]) => ({ label, value }));
}

async function acctExpensesTopVendors(userId: string, organizationId: number) {
  const result = await queryQbo(userId, organizationId, "SELECT Id, VendorRef, TotalAmt FROM Bill MAXRESULTS 1000");
  const bills = result?.QueryResponse?.Bill ?? [];
  const byVendor = new Map<string, number>();
  for (const bill of bills) {
    const name = bill.VendorRef?.name ?? "(unknown)";
    byVendor.set(name, (byVendor.get(name) ?? 0) + (Number(bill.TotalAmt) || 0));
  }
  return Array.from(byVendor.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

const RAW_QUERIES: Record<string, (userId: string, organizationId: number) => Promise<unknown>> = {
  "acct.revenue.total": acctRevenueTotal,
  "acct.expenses.total": acctExpensesTotal,
  "acct.netIncome": acctNetIncome,
  "acct.grossProfitMargin": acctGrossProfitMargin,
  "acct.revenue.byMonth": acctRevenueByMonth,
  "acct.expenses.byMonth": acctExpensesByMonth,
  "acct.expenses.byCategory": acctExpensesByCategory,
  "acct.cashBalance": acctCashBalance,
  "acct.accountsReceivable": acctAccountsReceivable,
  "acct.accountsPayable": acctAccountsPayable,
  "acct.currentRatio": acctCurrentRatio,
  "acct.invoices.overdue": acctInvoicesOverdue,
  "acct.invoices.byStatus": acctInvoicesByStatus,
  "acct.invoices.agingBuckets": acctInvoicesAgingBuckets,
  "acct.expenses.topVendors": acctExpensesTopVendors,
};

// ── Response cache ──────────────────────────────────────────────────────────
// QBO Reports/Query calls are slow (100s of ms) and rate-limited (500
// req/min per app in production, lower in sandbox). The dashboard polls
// periodically, so cache each (user, metric) result for a few minutes —
// mirrors the same pattern as /api/metrics/availability's cache.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map<string, { data: unknown; expiresAt: number }>();

export async function runQuickbooksQuery(key: string, userId: string, organizationId: number): Promise<unknown> {
  const fn = RAW_QUERIES[key];
  if (!fn) throw new Error(`no QuickBooks query registered for key: ${key}`);

  const cacheKey = `${organizationId}:${userId}:${key}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await fn(userId, organizationId);
  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/** Invalidate cached results for a user (e.g. after disconnect/reconnect). */
export function invalidateQuickbooksCache(userId: string, organizationId: number): void {
  const prefix = `${organizationId}:${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
