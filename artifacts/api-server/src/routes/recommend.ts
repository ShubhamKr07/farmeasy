import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { computeDashboardSnapshot } from "./dashboard";

const router = Router();

// Substrings that flag a question as being about the farm's own live
// operational numbers (as opposed to general crop/agronomy knowledge,
// which recommender-svc's farm_context.py already grounds via crop/seed
// name matching). Matched, not parsed — good enough to decide "should we
// attach a dashboard snapshot," not to extract structured intent.
const OPS_KEYWORDS = [
  "yield", "cycle", "harvest", "bad tray", "sensor", "alert", "channel",
  "seed lot", "utilization", "seeding", "germinat", "fertigat",
];

function questionMentionsOps(question: string): boolean {
  const q = question.toLowerCase();
  return OPS_KEYWORDS.some((k) => q.includes(k));
}

/** Same numbers GET /api/dashboard shows — one compute path, reused, not re-derived. */
function formatOpsContext(snapshot: Awaited<ReturnType<typeof computeDashboardSnapshot>>): string {
  const weekTrend = snapshot.yieldByWeek.map((w) => `${w.label}: ${w.value}kg`).join(", ");
  const utilizationPct = (snapshot.channelUtilization * 100).toFixed(0);
  const sensors = snapshot.sensorStatus;
  const sensorLine =
    sensors.sensorsOnline != null
      ? `Sensors: ${sensors.sensorsOnline}/${sensors.sensorsTotal} online. ` +
        `pH ${sensors.acidityPh ?? "—"}, water ${sensors.waterLevelPct ?? "—"}%, ` +
        `temp ${sensors.tempCelsius ?? "—"}°C, humidity ${sensors.humidityPct ?? "—"}%.`
      : "Sensor status unavailable.";

  return [
    `Total yield this week: ${snapshot.totalYieldThisWeek} kg (this month: ${snapshot.totalYieldThisMonth} kg).`,
    `Yield trend by week: ${weekTrend}.`,
    `Running cycles: ${snapshot.totalRunningCycles} across ${snapshot.activeCropTypes} crop types. ` +
      `Channel utilization: ${utilizationPct}% (${snapshot.totalRunningCycles}/${snapshot.totalChannels} channels).`,
    `Bad trays: ${snapshot.badTraysCount} in the last 7 days (${snapshot.totalBadTrays} total logged).`,
    `Current alerts: ${snapshot.currentAlertsCount} open (${snapshot.criticalAlertsCount} critical).`,
    sensorLine,
  ].join(" ");
}

/**
 * POST /api/recommend { question }
 *
 * Thin authenticated proxy to farmsmart-recommender (Python/FastAPI). Keeps
 * auth centralized here — the recommender service trusts this API via a
 * shared internal key, it doesn't re-validate the Clerk session itself.
 *
 * Questions about the farm's own live numbers ("what's my yield this
 * week?") get a dashboard snapshot attached as ops_context — recommender
 * -svc's own grounding only matches crop/seed names, so without this,
 * operational questions returned "no relevant results" (they don't match
 * any external search result or crop-specific growth profile).
 */
router.post("/recommend", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const question = (req.body as { question?: unknown })?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "question is required" });
  }

  const recommenderUrl = process.env.RECOMMENDER_URL;
  const internalKey = process.env.RECOMMENDER_INTERNAL_KEY;
  if (!recommenderUrl || !internalKey) {
    return res.status(503).json({ error: "recommender service is not configured" });
  }

  let opsContext: string | null = null;
  if (questionMentionsOps(question)) {
    try {
      opsContext = formatOpsContext(await computeDashboardSnapshot());
    } catch (err) {
      req.log.error(err); // non-fatal — proceed without ops context
    }
  }

  try {
    const upstream = await fetch(`${recommenderUrl}/recommend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": internalKey,
      },
      body: JSON.stringify({ clerk_user_id: userId, question, ops_context: opsContext }),
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    req.log.error(err);
    return res.status(502).json({ error: "recommender service unreachable" });
  }
});

export default router;
