import { Router, type Request, type Response } from "express";
import { sql, eq } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";
import { db, facilitiesTable, withTenantScope } from "@workspace/db";
import { METRICS_BY_ID, metricsForTab, type MetricTab, type TemplateName } from "@workspace/metrics";
import { TEMPLATES } from "../lib/metrics/templates";
import { isConnected as isQuickbooksConnected } from "../lib/accounting/quickbooks";

const router = Router();

/**
 * GET /api/metrics?tab=overview&keys=ov.yield.byMonth,ov.cycles.byStatus&range=30d
 *
 * Validates `keys` against the registry allowlist (never accepts raw SQL),
 * dispatches each to its query template, runs them concurrently, and returns
 * `{ "<key>": <data> }`.
 */
router.get("/metrics", async (req: Request, res: Response) => {
  const tab = req.query.tab as MetricTab | undefined;
  const keysParam = (req.query.keys as string | undefined) ?? "";
  const range = (req.query.range as string | undefined) ?? "all";
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);
  const { userId } = getAuth(req);
  const facilityId = req.tenant!.facilityId;

  const [facilityRow] = await db.select({ timezone: facilitiesTable.timezone }).from(facilitiesTable).where(eq(facilitiesTable.id, facilityId));
  const timezone = facilityRow?.timezone ?? "UTC";

  if (keys.length === 0) {
    return res.json({});
  }

  // Validate every key: must exist in the registry, belong to the tab (if tab
  // given), and declare a Tier-B template.
  const valid: { id: string; template: TemplateName; params: any }[] = [];
  for (const id of keys) {
    const def = METRICS_BY_ID.get(id);
    if (!def) return res.status(400).json({ error: `unknown metric: ${id}` });
    if (tab && def.tab !== tab) return res.status(400).json({ error: `metric ${id} not in tab ${tab}` });
    if (def.source !== "metrics" || !def.template || !def.templateParams) {
      return res.status(400).json({ error: `metric ${id} is not a Tier-B metrics query` });
    }
    valid.push({ id, template: def.template, params: def.templateParams });
  }

  try {
    // Every template/custom query's OWN scoping is a plain :facilityId
    // literal substitution (tz.ts), never a Postgres session variable -- but
    // 00007's RLS policies are still active on every table these queries
    // touch and require app.org_id/app.facility_id to be set to admit any
    // row. Without withTenantScope, these queries would run on a connection
    // that never sets that GUC, so RLS silently zeroes every result
    // regardless of the query's own correct scoping (found empirically:
    // MT-M1 Task 15/16, running the isolation suite against a real
    // non-BYPASSRLS role).
    const entries = await withTenantScope(req.tenant!, async (tx) => {
      return Promise.all(
        valid.map(async (v) => {
          try {
            const data = await TEMPLATES[v.template](v.params, facilityId, timezone, range, userId ?? undefined, req.tenant!.organizationId, tx);
            return [v.id, data] as const;
          } catch (err) {
            // One failing metric shouldn't 500 the whole batch; report per-key.
            return [v.id, { error: (err as Error).message }] as const;
          }
        }),
      );
    });
    return res.json(Object.fromEntries(entries));
  } catch (err) {
    return res.status(500).json({ error: "metrics query failed", detail: (err as Error).message });
  }
});

// ── Availability (rule: no per-metric null probing) ───────────────────────

interface Availability {
  revenue: boolean;
  sensor_readings: boolean;
  cost: boolean;
  crop_id: boolean;
  accounting_connected: boolean;
}

// Cached per facility (not one shared global value) -- these flags depend on
// facility-scoped data (shipments/growth_profiles), so caching one answer
// for every tenant would leak org A's "revenue available" flag onto org B's
// dashboard. accounting_connected is per-(organization, user) since each
// user has their own QuickBooks connection, cached separately with a
// shorter TTL, keyed accordingly.
const globalCache = new Map<number, { data: Omit<Availability, "accounting_connected">; expiresAt: number }>();
const GLOBAL_TTL_MS = 5 * 60 * 1000;
const acctCache = new Map<string, { connected: boolean; expiresAt: number }>();
const ACCT_TTL_MS = 60 * 1000;

// Wrapped in withTenantScope: shipments and growth_profiles are both
// RLS-protected (facility- and organization-scoped respectively) -- without
// this, app.facility_id/app.org_id are never set and RLS silently zeroes
// every EXISTS check regardless of what's actually stored (found during
// MT-M1's final review). sensor_readings itself has no RLS, but is scoped
// here too via a facility-owned sensor_id subquery for the same reason this
// whole function was flagged in the plan as "a real cross-tenant leak in
// spirit" when it was still a single global, unscoped check.
async function computeFacilityAvailability(
  tenant: { organizationId: number; facilityId: number },
): Promise<Omit<Availability, "accounting_connected">> {
  return withTenantScope(tenant, async (tx) => {
    const [rev, sensor, crop] = await Promise.all([
      tx.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM shipments WHERE revenue_usd IS NOT NULL AND deleted_at IS NULL AND facility_id = ${Number(tenant.facilityId)}) AS v`)),
      tx.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM sensor_readings WHERE sensor_id IN (SELECT id FROM sensors WHERE facility_id = ${Number(tenant.facilityId)})) AS v`)),
      tx.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM growth_profiles WHERE crop_id IS NOT NULL AND organization_id = ${Number(tenant.organizationId)}) AS v`)),
    ]);
    const v = (r: unknown) => Boolean((r as { rows: { v: boolean }[] }).rows[0]?.v);
    return {
      revenue: v(rev),
      sensor_readings: v(sensor),
      cost: false, // stock_movements has no unit-cost field; marginByCrop gated (dictionary caveat)
      crop_id: v(crop),
    };
  });
}

router.get("/metrics/availability", async (req: Request, res: Response) => {
  try {
    const facilityId = req.tenant!.facilityId;
    const organizationId = req.tenant!.organizationId;
    const cached = globalCache.get(facilityId);
    const data = cached && cached.expiresAt > Date.now()
      ? cached.data
      : await computeFacilityAvailability(req.tenant!).then((data) => {
          globalCache.set(facilityId, { data, expiresAt: Date.now() + GLOBAL_TTL_MS });
          return data;
        });

    const { userId } = getAuth(req);
    let accountingConnected = false;
    if (userId) {
      const acctCacheKey = `${organizationId}:${userId}`;
      const cachedAcct = acctCache.get(acctCacheKey);
      if (cachedAcct && cachedAcct.expiresAt > Date.now()) {
        accountingConnected = cachedAcct.connected;
      } else {
        accountingConnected = await isQuickbooksConnected(userId, organizationId);
        acctCache.set(acctCacheKey, { connected: accountingConnected, expiresAt: Date.now() + ACCT_TTL_MS });
      }
    }

    return res.json({ ...data, accounting_connected: accountingConnected });
  } catch (err) {
    return res.status(500).json({ error: "availability query failed", detail: (err as Error).message });
  }
});

/** Exposed for tests / migration tooling. */
export function resetAvailabilityCache() {
  globalCache.clear();
  acctCache.clear();
}

export function listTierBKeysForTab(tab: MetricTab): string[] {
  return metricsForTab(tab).filter((m) => m.source === "metrics").map((m) => m.id);
}

export default router;
