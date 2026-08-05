import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";
import { db } from "@workspace/db";
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
    const entries = await Promise.all(
      valid.map(async (v) => {
        try {
          const data = await TEMPLATES[v.template](v.params, range, userId ?? undefined, req.tenant!.organizationId);
          return [v.id, data] as const;
        } catch (err) {
          // One failing metric shouldn't 500 the whole batch; report per-key.
          return [v.id, { error: (err as Error).message }] as const;
        }
      }),
    );
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

// Global flags (same for every user) cached once; accounting_connected is
// per-user (each user has their own QuickBooks connection) so it's cached
// separately, keyed by clerk user id, with a shorter TTL.
let globalCache: { data: Omit<Availability, "accounting_connected">; expiresAt: number } | null = null;
const GLOBAL_TTL_MS = 5 * 60 * 1000;
const acctCache = new Map<string, { connected: boolean; expiresAt: number }>();
const ACCT_TTL_MS = 60 * 1000;

async function computeGlobalAvailability(): Promise<Omit<Availability, "accounting_connected">> {
  const [rev, sensor, crop] = await Promise.all([
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM shipments WHERE revenue_usd IS NOT NULL AND deleted_at IS NULL) AS v`)),
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM sensor_readings) AS v`)),
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM growth_profiles WHERE crop_id IS NOT NULL) AS v`)),
  ]);
  const v = (r: unknown) => Boolean((r as { rows: { v: boolean }[] }).rows[0]?.v);
  return {
    revenue: v(rev),
    sensor_readings: v(sensor),
    cost: false, // stock_movements has no unit-cost field; marginByCrop gated (dictionary caveat)
    crop_id: v(crop),
  };
}

router.get("/metrics/availability", async (req: Request, res: Response) => {
  try {
    if (!globalCache || globalCache.expiresAt <= Date.now()) {
      globalCache = { data: await computeGlobalAvailability(), expiresAt: Date.now() + GLOBAL_TTL_MS };
    }

    const { userId } = getAuth(req);
    let accountingConnected = false;
    if (userId) {
      const cached = acctCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        accountingConnected = cached.connected;
      } else {
        accountingConnected = await isQuickbooksConnected(userId, req.tenant!.organizationId);
        acctCache.set(userId, { connected: accountingConnected, expiresAt: Date.now() + ACCT_TTL_MS });
      }
    }

    return res.json({ ...globalCache.data, accounting_connected: accountingConnected });
  } catch (err) {
    return res.status(500).json({ error: "availability query failed", detail: (err as Error).message });
  }
});

/** Exposed for tests / migration tooling. */
export function resetAvailabilityCache() {
  globalCache = null;
  acctCache.clear();
}

export function listTierBKeysForTab(tab: MetricTab): string[] {
  return metricsForTab(tab).filter((m) => m.source === "metrics").map((m) => m.id);
}

export default router;
