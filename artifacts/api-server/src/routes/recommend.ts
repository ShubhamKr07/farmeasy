import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { getAuth } from "../middlewares/supabaseAuth";
import { computeDashboardSnapshot } from "./dashboard";

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

// --- Task 9 Step 6: bound what reaches the recommender ---------------------

/** Recommendation questions are capped at 2,000 chars (strictly greater rejected). */
const MAX_QUESTION_LENGTH = 2000;

/**
 * Default deadline for the upstream recommender `fetch()` (Task 9 Step 6). A
 * hung recommender can't hold an API connection open indefinitely —
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException after the
 * deadline and the handler turns that into a clean 502. This is a process-
 * local tuning knob; production runs with the 10s default and does NOT
 * expose it in render.yaml. Overridable via `RECOMMENDER_FETCH_TIMEOUT_MS`
 * purely so the timeout path is unit-testable without a real 10s wait.
 */
const DEFAULT_RECOMMENDER_TIMEOUT_MS = 10_000;

function recommenderFetchTimeoutMs(): number {
  const raw = process.env.RECOMMENDER_FETCH_TIMEOUT_MS;
  const parsed = raw === undefined ? DEFAULT_RECOMMENDER_TIMEOUT_MS : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECOMMENDER_TIMEOUT_MS;
}

// --- Task 9 Step 5: independent recommendation rate limits -----------------
//
// TWO separate, independent limiter middlewares (NOT a composite key). The
// per-USER budget (20 req/15 min, keyed by authenticated userId) and the
// per-IP budget (60 req/15 min, keyed by ipKeyGenerator(req.ip)) are
// independently exhaustible: many distinct authenticated users behind one
// NAT'd IP each keep their own 20-request budget, while the IP's aggregate
// is separately capped at 60 to bound total cost from that source. Both
// use process-local MemoryStore (the brief: prohibit horizontal API scaling
// until a shared store exists).

/** 15-minute window shared by both limiters. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Per-user budget: 20 recommendations / 15 min. */
const USER_RECOMMEND_LIMIT = 20;

/** Per-IP budget: 60 recommendations / 15 min. */
const IP_RECOMMEND_LIMIT = 60;

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
async function recommendHandler(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  // Validate + bound the question BEFORE any dashboard/ops-context work runs
  // (Task 9 Step 6): an oversized payload must not drive the (expensive)
  // ops-keyword scan, a dashboard snapshot computation, or the bytes we
  // forward to the recommender. Reject strictly greater than the cap.
  const rawQuestion = (req.body as { question?: unknown })?.question;
  if (typeof rawQuestion !== "string" || rawQuestion.trim().length === 0) {
    return res.status(400).json({ error: "question is required" });
  }
  const question = rawQuestion.trim();
  if (question.length > MAX_QUESTION_LENGTH) {
    return res
      .status(400)
      .json({ error: `question must be at most ${MAX_QUESTION_LENGTH} characters` });
  }

  const recommenderUrl = process.env.RECOMMENDER_URL;
  const internalKey = process.env.RECOMMENDER_INTERNAL_KEY;
  if (!recommenderUrl || !internalKey) {
    return res.status(503).json({ error: "recommender service is not configured" });
  }

  let opsContext: string | null = null;
  if (questionMentionsOps(question)) {
    try {
      opsContext = formatOpsContext(await computeDashboardSnapshot(req.tenant!));
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
      body: JSON.stringify({
        user_id: userId,
        question,
        ops_context: opsContext,
      }),
      // 10s deadline so a hung upstream can't pin the connection. Aborts
      // with a DOMException named "TimeoutError", caught below → 502.
      signal: AbortSignal.timeout(recommenderFetchTimeoutMs()),
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    // Distinguish a deadline timeout from a generic connection failure for
    // logs/observability; both surface to the client as 502 (the recommender
    // is unreachable within the budget either way). Undici throws the same
    // DOMException for a manual AbortController abort, so cover both names.
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    req.log.error(
      { err, recommender_url: recommenderUrl, timed_out: timedOut },
      timedOut ? "recommender fetch timed out" : "recommender fetch failed",
    );
    return res.status(502).json({ error: "recommender service unreachable" });
  }
}

/**
 * Build a fresh recommend router with its OWN rate-limit stores.
 *
 * `app.ts` calls this once at startup for the default export. Tests call it
 * per-suite so each suite gets an isolated process-local MemoryStore —
 * without that, one test's exhaustion would bleed into the next (the default
 * store is per-limiter-instance, not per-request).
 *
 * The two limiters are separate middlewares mounted in sequence on the
 * POST /recommend route. The per-user limiter keys on the authenticated
 * `userId` (always present in production — `requireSignedIn` in app.ts 401s
 * before this router — so the "anon" fallback is a type-safety net, not a
 * load path). The per-IP limiter uses express-rate-limit's DEFAULT
 * keyGenerator, which keys by `ipKeyGenerator(req.ip)` (with IPv6 subnet
 * normalization) — exactly the per-IP keying Task 9 Step 5 specifies. `req.ip`
 * is only trustworthy here because `app.ts` sets Express `trust proxy` to
 * `TRUST_PROXY_HOPS` in production.
 */
export function createRecommendRouter(): Router {
  const router = Router();

  // Per-USER budget. NOTE: do NOT reference `req.ip` in this keyGenerator —
  // express-rate-limit's `keyGeneratorIpFallback` validation rejects custom
  // keyGenerators that touch `req.ip` without routing it through
  // `ipKeyGenerator` (to prevent IPv6 bypass). `getAuth(req).userId` doesn't
  // touch `req.ip`, so it's safe.
  const userLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: USER_RECOMMEND_LIMIT,
    keyGenerator: (req) => getAuth(req).userId ?? "anon",
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many recommendation requests for this user. Please try again later.",
      });
    },
    // Two limiters would emit conflicting X-RateLimit-* headers (second
    // overwrites first on the success path); suppress legacy headers and rely
    // on the 429 JSON body, which names which budget was hit.
    legacyHeaders: false,
  });

  // Per-IP budget. Default keyGenerator → ipKeyGenerator(req.ip) (IPv6
  // subnet-normalized). Kept separate from userLimiter so the IP budget is
  // independently exhaustible.
  const ipLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: IP_RECOMMEND_LIMIT,
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many recommendation requests from this network. Please try again later.",
      });
    },
    legacyHeaders: false,
  });

  router.post("/recommend", userLimiter, ipLimiter, recommendHandler);

  return router;
}

const recommendRouter = createRecommendRouter();
export default recommendRouter;
