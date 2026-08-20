import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { trackSession, authenticate, requirePerm } from "../../middleware/sessionAuth.js";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { query } from "../../db/pool.js";
import { getAllGaps, countPendingGaps } from "../../db/gaps.js";
import { getStreamEvents } from "../../db/streamEvents.js";
import { getAllSettings, getSetting, getSettingMeta, setSetting } from "../../db/appSettings.js";
import { getPermissionsForUser } from "../../db/permissions.js";
import { recordAdminAction, listAdminActions } from "../../db/adminActions.js";
import { get24hSourceStats, getCandles, getCollectionLatencyStats, getSourceCandles, VALID_TFS } from "../../db/candles.js";
import { runGapScan } from "../../lib/gapDetector.js";
import {
  getEnabledCurrencies, listCurrencies, getCurrency,
  setCurrencyEnabled, setPremiumEnabled, setFlatFillEmpty, setMinSources, setInceptionTs, setSourceRetentionDays,
} from "../../db/currencies.js";
import {
  getFormulaTimeline, insertFormulaVersion, deleteFormulaVersion,
} from "../../db/formulaVersions.js";
import { getExchangeTuning } from "../../lib/exchangeConfig.js";
import { getFeedMap, setFeedEnabled, setAvailability, getActiveFeeds } from "../../db/currencyFeeds.js";
import { onboardCurrency } from "../../lib/healer.js";
import { ADAPTER_BY_NAME } from "../../adapters/registry.js";
import { getSourceStatus, resumeSource } from "../../lib/collector.js";
import { RATE_LIMIT_DEFAULTS } from "../../lib/rateLimit.js";
import {
  applyFormulaDelta,
  getCurrentFormula,
  getLastChange,
} from "../../db/formulaChanges.js";
import { SOURCE_NAMES } from "../../adapters/registry.js";
import {
  listApiKeys, createApiKey, revokeApiKey, setApiKeyEnabled,
  repairApiKeyNonce, findAndRepairBrokenNonces,
} from "../../db/apiKeys.js";
import { findUserById } from "../../db/users.js";
import { getAllServiceEvents } from "../../db/serviceEvents.js";
import {
  startRepairJob, previewRepair, getRepairJob, getActiveRepairJob, cancelRepairJob,
  isCurrencyRepairing, validateRepairWindow, ALL_REPAIR_STEPS,
} from "../../lib/repairJobs.js";
import type { RepairStep } from "../../lib/repairJobs.js";
import { getHealerActivities } from "../../lib/healerStatus.js";
import { isDemoMode, readCap } from "../../lib/demoMode.js";
import { redisGet, redisSet, boundaryTtl } from "../../lib/redis.js";
import { recordApiRequest, apiStatsSnapshot } from "../../lib/apiCounter.js";
import { buildRuntimeSnapshot, flushCandleCache } from "../../lib/runtimeStats.js";
import { deleteAllSessions } from "../../db/sessions.js";
import { logError } from "../../lib/log.js";

const router = Router();
const view   = [trackSession, authenticate, requirePerm("CAN_VIEW_CANDLESERV")];
const modify = [trackSession, authenticate, requirePerm("CAN_MODIFY_CANDLESERV")];

// Accept either an API key (Authorization header, same scheme as /v1) or a
// logged-in session with CAN_VIEW_CANDLESERV. Machine clients send a key; the
// monitor UI sends a session cookie. The presence of the Authorization header
// selects the API-key path; otherwise we fall through to the session chain.
// (trackSession would mint a cookie for API clients, so we skip it for them.)
const viewOrApiKey = [
  (req: Request, res: Response, next: NextFunction) =>
    req.headers["authorization"] ? apiKeyAuth(req, res, next) : next(),
  (req: Request, res: Response, next: NextFunction) =>
    req.apiKeyId ? next() : trackSession(req, res, next),
  (req: Request, res: Response, next: NextFunction) =>
    req.apiKeyId ? next() : authenticate(req, res, next),
  (req: Request, res: Response, next: NextFunction) =>
    req.apiKeyId ? next() : requirePerm("CAN_VIEW_CANDLESERV")(req, res, next),
];

// Resolve the acting operator's identity for the audit log. One small lookup
// per mutation (not a hot path); falls back to user:<id> / "unknown".
async function actorOf(req: import("express").Request): Promise<string> {
  const id = req.userId;
  if (!id) return "unknown";
  try {
    const u = await findUserById(id);
    return u?.email ?? `user:${id}`;
  } catch {
    return `user:${id}`;
  }
}

/** GET /monitor/candles?tf=<tf>&endingAt=<iso>&limit=<n> — historical page for monitor chart */
router.get("/candles", ...view, async (req, res) => {
  const { tf, endingAt, limit } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) return res.status(400).json({ error: "Invalid tf" });
  if (!endingAt) return res.status(400).json({ error: "endingAt required" });
  const end = new Date(endingAt);
  if (isNaN(end.getTime())) return res.status(400).json({ error: "Invalid endingAt" });
  const count = Math.min(parseInt(limit, 10) || 500, await readCap(2000));
  const currency = (req.query.currency as string)?.toUpperCase() || "BTC";
  try {
    // Public demo serves these reads (it 403s /v1, where the cache normally
    // lives), so cache them here to absorb public load — reusing the /v1
    // candles:* key scheme + boundaryTtl, so the existing flush covers both.
    // Authed admins skip the cache and always read fresh from the DB.
    const cacheKey = `candles:${currency}:${tf}:${end.getTime()}:${count}`;
    if (req.demoRead) {
      const cached = await redisGet(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }
    const candles = await getCandles({ currency, tf, endingAt: end, limit: count });
    const payload = { candles };
    if (req.demoRead) await redisSet(cacheKey, JSON.stringify(payload), boundaryTtl(tf, end));
    return res.json(payload);
  } catch (err) {
    logError("[monitor] GET /candles failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/candles/latest?tf=<tf>&n=<n> — session auth, for monitor UI */
router.get("/candles/latest", ...view, async (req, res) => {
  const { tf, n } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) return res.status(400).json({ error: "Invalid tf" });
  const count = Math.min(parseInt(n, 10) || 1, await readCap(5000));
  const currency = (req.query.currency as string)?.toUpperCase() || "BTC";
  try {
    // Demo-only cache (see GET /candles above): absorbs public load on the
    // latest-candle poll. Authed admins read fresh.
    const cacheKey = `candles:latest:${currency}:${tf}:${count}`;
    if (req.demoRead) {
      const cached = await redisGet(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }
    const candles = await getCandles({ currency, tf, endingAt: new Date(), limit: count });
    const payload = { candles };
    if (req.demoRead) await redisSet(cacheKey, JSON.stringify(payload), boundaryTtl(tf));
    return res.json(payload);
  } catch (err) {
    logError("[monitor] GET /candles/latest failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/gaps — readable by API key or session view */
router.get("/gaps", ...viewOrApiKey, async (req, res) => {
  const currency = (req.query.currency as string)?.toUpperCase() || undefined;
  const gaps = await getAllGaps(200, currency);
  return res.json({ gaps: gaps.map((g) => ({
    ...g,
    timestamp: g.timestamp.toISOString(),
    detectedAt: g.detectedAt.toISOString(),
    healedAt: g.healedAt?.toISOString() ?? null,
    updatedAt: g.updatedAt.toISOString(),
  }))});
});

/** POST /monitor/heal — trigger a manual gap scan */
router.post("/heal", ...modify, async (_req, res) => {
  void (async () => {
    for (const currency of await getEnabledCurrencies()) {
      await runGapScan(7, currency);
    }
  })().catch((err) => logError("[monitor] POST /heal runGapScan failed:", err));
  return res.json({ ok: true, message: "Heal scan started" });
});

/** GET /monitor/stats */
router.get("/stats", ...view, async (_req, res) => {
  try {
    const [countRes, oldestRes, newestRes, distRes, latency] = await Promise.all([
      query(`SELECT COUNT(*) FROM candles_1m`),
      query(`SELECT "timestamp" FROM candles_1m ORDER BY "timestamp" ASC LIMIT 1`),
      query(`SELECT "timestamp" FROM candles_1m ORDER BY "timestamp" DESC LIMIT 1`),
      query(`SELECT "sourceCount", COUNT(*) AS cnt FROM candles_1m GROUP BY "sourceCount" ORDER BY "sourceCount"`),
      getCollectionLatencyStats("BTC", 60),
    ]);
    const dist: Record<string, number> = {};
    for (const row of distRes.rows) dist[String(row.sourceCount)] = Number(row.cnt);
    return res.json({
      totalRows: Number(countRes.rows[0].count),
      oldestCandle: oldestRes.rows[0]?.timestamp ?? null,
      newestCandle: newestRes.rows[0]?.timestamp ?? null,
      sourceCountDistribution: dist,
      collectionLatency: latency,
    });
  } catch (err) {
    logError("[monitor] GET /stats failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/sources/status */
router.get("/sources/status", ...view, async (req, res) => {
  const status = await getSourceStatus();
  if (req.demoRead) {
    for (const s of Object.values(status)) s.excludedBy = redactActor(s.excludedBy);
  }
  return res.json({ sources: status });
});

/**
 * GET /monitor/sources/candles?currency=&days=7 — per-source 1m OHLCV (+peg) for
 * the Candles-tab source hover popup. Loaded once per session (never auto-refreshed),
 * so it's exempt from the demo read cap; the window is hard-capped at 7 days.
 */
router.get("/sources/candles", ...view, async (req, res) => {
  const currency = (req.query.currency as string)?.toUpperCase() || "BTC";
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 7);
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const rows = await getSourceCandles(currency, from, to);
    return res.json({ rows });
  } catch (err) {
    logError("[monitor] GET /sources/candles failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// Strip operator identity (emails) from demo-served reads — the public demo must
// never surface WHO did what. Preserves any non-email prefix label (e.g. "manual:").
function redactActor(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  if (!s.includes("@")) return s;
  const colon = s.indexOf(":");
  return colon >= 0 ? `${s.slice(0, colon)}:operator` : "operator";
}

function lastChangePayload() {
  const last = getLastChange();
  if (!last) return null;
  return {
    at: last.createdAt.toISOString(),
    by: last.by,
    exchange: last.exchange,
    setOrUnset: last.setOrUnset,
    reason: last.reason,
  };
}

/** GET /monitor/formula — current excludedSources + lastChange metadata */
router.get("/formula", ...view, (req, res) => {
  const lastChange = lastChangePayload();
  if (lastChange && req.demoRead) lastChange.by = redactActor(lastChange.by) ?? lastChange.by;
  return res.json({
    excludedSources: getCurrentFormula().excludedSources,
    lastChange,
  });
});

/**
 * PUT /monitor/formula — replace the formula with the desired set.
 * Body: { excludedSources: string[] }. Server computes diff vs current and
 * inserts one formula_changes row per transition (idempotent on no-ops).
 * Each 'set' transition snapshots 24h stats at the moment of insert.
 */
router.put("/formula", ...modify, async (req, res) => {
  const body = req.body as { excludedSources?: unknown };
  if (!Array.isArray(body?.excludedSources)
      || !body.excludedSources.every((s) => typeof s === "string")) {
    return res.status(400).json({ error: "Body must be { excludedSources: string[] }" });
  }
  const desired = body.excludedSources as string[];
  const unknown = desired.filter((s) => !SOURCE_NAMES.includes(s));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown source(s): ${unknown.join(", ")}` });
  }

  // Snapshot stats for any newly-excluded source — done here, not in the
  // helper, because we want the snapshot computed before the insert lands.
  // For batch PUTs of multiple newly-excluded sources we don't try to fan out
  // per-exchange snapshots in this handler; the typical operator workflow is
  // single-exchange and that's where the UI's "Last seen at exclusion" panel
  // matters most. Auto-suspend (collector.ts) does per-source snapshots.
  const newlyExcluded = desired.filter((s) => !getCurrentFormula().excludedSources.includes(s));
  let statsAtExclusion = null;
  if (newlyExcluded.length === 1) {
    const stats = await get24hSourceStats(newlyExcluded[0]);
    statsAtExclusion = {
      failures24h: null,
      outlierRate24h: stats.outlierRate24h,
      usedRate24h: stats.usedRate24h,
    };
  }
  // Multi-source PUTs don't get a stats snapshot — the snapshot is "what was
  // this one exchange's stats at the moment of exclusion" and that doesn't
  // generalize cleanly across multiple in a single PUT. Single-exchange PUTs
  // (the typical operator workflow) get the snapshot.

  // Resolve the operator's identifier for the `by` column — prefer email so
  // UI labels read "by ken@example.com" rather than "by user-123". Fall back
  // to numeric id if the lookup fails (defensive — auth middleware already
  // verified the user exists).
  const userId = (req as { userId?: number }).userId;
  let userLabel = "manual";
  if (userId !== undefined) {
    try {
      const u = await findUserById(userId);
      userLabel = `manual:${u?.email ?? `user-${userId}`}`;
    } catch {
      userLabel = `manual:user-${userId}`;
    }
  }

  await applyFormulaDelta(
    { excludedSources: desired },
    userLabel,
    "operator edit via PUT /monitor/formula",
    statsAtExclusion,
  );

  return res.json({
    excludedSources: getCurrentFormula().excludedSources,
    lastChange: lastChangePayload(),
  });
});

// ── Repair operations ────────────────────────────────────────────────────────

/**
 * POST /monitor/repair?dry=<true|false>
 *   body: { from: ISO, to: ISO, sources?: string[], formula?: { excludedSources: string[] },
 *           retryEmpty?: boolean, steps?: ("fetch"|"stables"|"recompose")[] }
 *
 * steps selects which units run (any non-empty subset); absent = all three (the
 * full fetch→stables→recompose chain). Recompose-only = { steps: ["recompose"] }
 * — re-derives the composite from the existing archive with no exchange fetches.
 *
 * dry=true returns { preview }. dry=false starts a job and returns { jobId }.
 * Single-flight: rejects with 409 if a job is already running.
 *
 * Window guards (validateRepairWindow):
 *   from ≥ NOW() - repairHorizonDays  (operator-configurable; default 180d)
 *   to   ≤ floor(NOW() to minute) - 1m  (never touches the in-progress minute)
 */
router.post("/repair", ...modify, async (req, res) => {
  const body = req.body as {
    currency?: unknown;
    from?: string;
    to?: string;
    sources?: unknown;
    formula?: { excludedSources?: unknown };
    retryEmpty?: unknown;
    repairExistingTokenMinutes?: unknown;
    repairExistingStableMinutes?: unknown;
    steps?: unknown;
    suspendGlobal?: unknown;
  };
  if (typeof body?.from !== "string" || typeof body?.to !== "string") {
    return res.status(400).json({ error: "Body must include from + to (ISO strings)" });
  }

  const currency = (typeof body.currency === "string" && body.currency.trim())
    ? body.currency.trim().toUpperCase()
    : "BTC";
  const enabledCurrencies = await getEnabledCurrencies();
  if (!enabledCurrencies.includes(currency)) {
    return res.status(400).json({ error: `Unknown or disabled currency '${currency}'. Enabled: ${enabledCurrencies.join(", ")}` });
  }
  const from = new Date(body.from);
  const to   = new Date(body.to);
  const winErr = await validateRepairWindow(from, to);
  if (winErr) return res.status(400).json({ error: winErr });

  let sources: string[] | undefined;
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources) || !body.sources.every((s) => typeof s === "string")) {
      return res.status(400).json({ error: "sources must be string[]" });
    }
    sources = body.sources as string[];
    const unknown = sources.filter((s) => !SOURCE_NAMES.includes(s));
    if (unknown.length) return res.status(400).json({ error: `Unknown source(s): ${unknown.join(", ")}` });
  }

  let formula: { excludedSources: string[] } | undefined;
  if (body.formula !== undefined) {
    const f = body.formula;
    if (!f || !Array.isArray(f.excludedSources) || !f.excludedSources.every((s) => typeof s === "string")) {
      return res.status(400).json({ error: "formula must be { excludedSources: string[] }" });
    }
    formula = { excludedSources: f.excludedSources as string[] };
    const unknown = formula.excludedSources.filter((s) => !SOURCE_NAMES.includes(s));
    if (unknown.length) return res.status(400).json({ error: `Unknown source(s) in formula override: ${unknown.join(", ")}` });
  }

  // Optional step selection — any non-empty subset of fetch/stables/recompose.
  // Default (absent) = all three = the full fetch→stables→recompose chain.
  // Recompose-only = { steps: ["recompose"] } (no exchange fetches).
  let steps: RepairStep[] | undefined;
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps) || !body.steps.every((s) => typeof s === "string")) {
      return res.status(400).json({ error: "steps must be string[]" });
    }
    const valid = new Set<string>(ALL_REPAIR_STEPS);
    const bad = (body.steps as string[]).filter((s) => !valid.has(s));
    if (bad.length) return res.status(400).json({ error: `Unknown step(s): ${bad.join(", ")} (valid: ${ALL_REPAIR_STEPS.join(", ")})` });
    const dedup = [...new Set(body.steps as RepairStep[])];
    if (dedup.length === 0) return res.status(400).json({ error: "steps must be a non-empty subset of fetch, stables, recompose" });
    steps = dedup;
  }

  const retryEmpty = Boolean(body.retryEmpty);
  // Existing-minute toggles. OFF (default) → fill only holes (coverage-
  // skip, fast/resumable). ON → re-fetch + overwrite that domain.
  const repairExistingTokenMinutes = Boolean(body.repairExistingTokenMinutes);
  const repairExistingStableMinutes = Boolean(body.repairExistingStableMinutes);
  // Block ALL candle reads during the repair (not just this currency). Surfaced
  // by the UI when the stable toggle is on, since pegs are shared.
  const suspendGlobal = Boolean(body.suspendGlobal);
  const dry = req.query.dry === "true";

  if (dry) {
    try {
      const preview = await previewRepair({ currency, from, to, sources, formula, retryEmpty, repairExistingTokenMinutes, repairExistingStableMinutes, steps, suspendGlobal });
      return res.json({ preview });
    } catch (err) {
      logError("[monitor] POST /repair?dry=true failed:", err);
      return res.status(500).json({ error: String(err) });
    }
  }

  // Wet run — per-currency single-flight check + start job.
  if (isCurrencyRepairing(currency)) {
    return res.status(409).json({ error: `a repair job is already in progress for ${currency}` });
  }
  try {
    const { jobId } = startRepairJob({ currency, from, to, sources, formula, retryEmpty, repairExistingTokenMinutes, repairExistingStableMinutes, steps, suspendGlobal });
    void recordAdminAction({
      actor: await actorOf(req),
      action: "repair.start",
      target: currency,
      detail: { jobId, from: from.toISOString(), to: to.toISOString(), retryEmpty, repairExistingTokenMinutes, repairExistingStableMinutes, steps, suspendGlobal, formula: formula?.excludedSources },
    });
    return res.json({ jobId });
  } catch (err) {
    logError("[monitor] POST /repair start failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /monitor/healer/status — returns the currently-running healer activities
 * (boot backfill, hourly gap scan, low-confidence re-heal). Empty array = idle.
 */
router.get("/healer/status", ...view, (_req, res) => {
  return res.json({ activities: getHealerActivities() });
});

/**
 * GET /monitor/repair/current — returns the currently-running job's state, or
 * null when nothing is in flight. Lets the frontend recover from tab-navigation
 * away/back: the server's single-flight flag is authoritative, the client just
 * needs the jobId to resume polling.
 */
router.get("/repair/current", ...view, (_req, res) => {
  const state = getActiveRepairJob();
  return res.json(state ?? null);
});

/** GET /monitor/repair/jobs/:jobId — poll job state */
router.get("/repair/jobs/:jobId", ...view, (req, res) => {
  const state = getRepairJob(req.params.jobId);
  if (!state) return res.status(404).json({ error: "unknown jobId" });
  return res.json(state);
});

/** POST /monitor/repair/jobs/:jobId/cancel — signal cancellation */
router.post("/repair/jobs/:jobId/cancel", ...modify, (req, res) => {
  const r = cancelRepairJob(req.params.jobId);
  if (!r.ok) return res.status(400).json({ error: r.error });
  return res.json({ ok: true });
});

/**
 * GET /monitor/sources/:source/history?days=180
 *   → { source, days, bins: [{day, used, outlierRejected, formulaExcluded, missing}],
 *       lifetime: {...}, last30d: {...} }
 *
 * Per-day breakdown from candles_1m_sources. Bins cover 1440 expected minutes
 * each; missing = 1440 - (used + outlierRejected + formulaExcluded). Sentinel
 * rows (rejectedReason='no_data') count toward missing in the UI's view.
 */
router.get("/sources/:source/history", ...view, async (req, res) => {
  const source = req.params.source;
  if (!SOURCE_NAMES.includes(source)) {
    return res.status(400).json({ error: `Unknown source: ${source}` });
  }
  const daysParam = parseInt((req.query.days as string) ?? "180", 10);
  if (!Number.isFinite(daysParam) || daysParam < 1 || daysParam > 365) {
    return res.status(400).json({ error: "days must be 1..365" });
  }

  try {
    const dailyRes = await query(
      `SELECT
         (date_trunc('day', timestamp) AT TIME ZONE 'UTC')::date AS day,
         COUNT(*) FILTER (WHERE "usedInFormula" = true)                                              AS used,
         COUNT(*) FILTER (WHERE rejected = true AND COALESCE("rejectedReason",'') <> 'no_data')      AS outlier_rejected,
         COUNT(*) FILTER (WHERE "usedInFormula" = false AND rejected = false)                       AS formula_excluded,
         COUNT(*) FILTER (WHERE "rejectedReason" = 'no_data')                                       AS no_data
       FROM candles_1m_sources
       WHERE source = $1
         AND timestamp >= date_trunc('day', NOW()) - ($2::int - 1) * INTERVAL '1 day'
       GROUP BY day
       ORDER BY day`,
      [source, daysParam],
    );

    const MINUTES_PER_DAY = 1440;
    interface Row { day: Date; used: string; outlier_rejected: string; formula_excluded: string; no_data: string }
    const byDay = new Map<string, Row>();
    for (const r of dailyRes.rows as Row[]) {
      // Postgres returns the date as a Date object; key by ISO date string.
      const d = new Date(r.day);
      byDay.set(d.toISOString().slice(0, 10), r);
    }

    // Fill every day in the window so the chart has no gaps.
    const bins: Array<{ day: string; used: number; outlierRejected: number; formulaExcluded: number; missing: number }> = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = daysParam - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      const used = Number(row?.used ?? 0);
      const outlierRejected = Number(row?.outlier_rejected ?? 0);
      const formulaExcluded = Number(row?.formula_excluded ?? 0);
      // Missing = expected minus everything we know about. no_data sentinels
      // are NOT subtracted — they count as "missing" in the UI's view (the
      // exchange had nothing for that minute, same as never trying).
      const missing = Math.max(0, MINUTES_PER_DAY - used - outlierRejected - formulaExcluded);
      bins.push({ day: d.toISOString(), used, outlierRejected, formulaExcluded, missing });
    }

    const sum = (sel: (b: typeof bins[number]) => number) => bins.reduce((acc, b) => acc + sel(b), 0);
    const lifetime = {
      totalRows: sum((b) => b.used + b.outlierRejected + b.formulaExcluded),
      used:            sum((b) => b.used),
      outlierRejected: sum((b) => b.outlierRejected),
      formulaExcluded: sum((b) => b.formulaExcluded),
      missing:         sum((b) => b.missing),
    };
    const last30 = bins.slice(-30);
    const sum30 = (sel: (b: typeof bins[number]) => number) => last30.reduce((acc, b) => acc + sel(b), 0);
    const last30d = {
      totalRows: sum30((b) => b.used + b.outlierRejected + b.formulaExcluded),
      used:            sum30((b) => b.used),
      outlierRejected: sum30((b) => b.outlierRejected),
      formulaExcluded: sum30((b) => b.formulaExcluded),
      missing:         sum30((b) => b.missing),
    };

    return res.json({ source, days: daysParam, bins, lifetime, last30d });
  } catch (err) {
    logError("[monitor] GET /sources/:source/history failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /monitor/sources/:source/resume — manual auto-ban recovery. Calls
 * resumeSource, which clears the Redis suspend overlay + the source's 24h
 * failure window so it resumes live polling without immediately re-tripping.
 * Does not touch the formula / formula_changes — that's PUT /monitor/formula.
 */
router.post("/sources/:source/resume", ...modify, async (req, res) => {
  await resumeSource(req.params.source);
  return res.json({ ok: true });
});

/** GET /monitor/stream-events */
router.get("/stream-events", ...view, async (req, res) => {
  const { minutes, source } = req.query as Record<string, string>;
  const events = await getStreamEvents({
    minutes: minutes ? parseInt(minutes, 10) : 60,
    source: source || undefined,
  });
  return res.json({ events });
});

/** GET /monitor/ping — lightweight session keepalive */
router.get("/ping", ...view, (_req, res) => {
  return res.json({ ok: true });
});

/**
 * GET /monitor/me — the authed user's permission map + demo flag, for frontend
 * tab gating. Returns the real permission map (not a fabricated
 * isAdmin) so the UI gates Connections/Feeds/Admin on CAN_MODIFY_CANDLESERV,
 * consistent with the requirePerm guards on the modify routes.
 */
router.get("/me", ...view, async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const perms = await getPermissionsForUser(userId);
  return res.json({ perms, isDemo: await isDemoMode() });
});

// ── Runtime / ops panel (authed twins of the localhost /internal API) ──────────

/** GET /monitor/runtime — in-memory + process stats for the admin Runtime panel. */
router.get("/runtime", ...view, async (_req, res) => {
  try {
    return res.json(await buildRuntimeSnapshot());
  } catch (err) {
    logError("[monitor] GET /runtime failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/api-stats — rolling 1h/4h/8h/24h outgoing-request counters. */
router.get("/api-stats", ...view, (_req, res) => {
  return res.json(apiStatsSnapshot());
});

/** POST /monitor/cache/flush — drop the candle redis cache (candles:* keys). */
router.post("/cache/flush", ...modify, async (req, res) => {
  try {
    const r = await flushCandleCache();
    void recordAdminAction({ actor: await actorOf(req), action: "cache.flush", target: null, detail: r });
    return res.json({ ok: true, ...r });
  } catch (err) {
    logError("[monitor] POST /cache/flush failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /monitor/sessions/flush — delete ALL sessions. Logs out every browser
 * INCLUDING the caller; the frontend confirms before calling.
 */
router.post("/sessions/flush", ...modify, async (req, res) => {
  try {
    const actor = await actorOf(req);
    const removed = await deleteAllSessions();
    void recordAdminAction({ actor, action: "sessions.flush", target: null, detail: { removed } });
    return res.json({ ok: true, removed });
  } catch (err) {
    logError("[monitor] POST /sessions/flush failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/service-events */
router.get("/service-events", ...view, async (_req, res) => {
  try {
    const events = await getAllServiceEvents(200);
    return res.json({ events: events.map((e) => ({
      ...e,
      startedAt: e.startedAt.toISOString(),
      endedAt: e.endedAt.toISOString(),
      createdAt: e.createdAt.toISOString(),
    }))});
  } catch (err) {
    logError("[monitor] GET /service-events failed:", err);
    return res.json({ events: [] });
  }
});

/** GET /monitor/config */
router.get("/config", ...view, async (_req, res) => {
  const settings = await getAllSettings();
  return res.json({ settings });
});

/** POST /monitor/config */
router.post("/config", ...modify, async (req, res) => {
  const body = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    await setSetting(key, String(value));
  }
  // Audit the keys changed, not the values — some (redisUrl) can carry secrets.
  void recordAdminAction({
    actor: await actorOf(req),
    action: "config.update",
    target: null,
    detail: { keys: Object.keys(body) },
  });
  return res.json({ ok: true });
});

/**
 * GET /monitor/rate-limits — per-venue API rate gate intervals (ms). defaultMs is
 * the built-in const; overrideMs is the app_settings rateLimit.<venue> value (or
 * null if unset). Edits go through POST /config writing rateLimit.<venue>.
 */
router.get("/rate-limits", ...view, async (_req, res) => {
  const rateLimits = await Promise.all(
    SOURCE_NAMES.map(async (source) => {
      const ov = await getSetting(`rateLimit.${source}`);
      return {
        source,
        defaultMs: RATE_LIMIT_DEFAULTS[source] ?? 0,
        overrideMs: ov != null && ov !== "" ? Number(ov) : null,
      };
    }),
  );
  return res.json({ rateLimits });
});

/** GET /monitor/admin/keys */
router.get("/admin/keys", ...modify, async (_req, res) => {
  const keys = await listApiKeys();
  return res.json({ keys });
});

/** POST /monitor/admin/keys */
router.post("/admin/keys", ...modify, async (req, res) => {
  const { label } = req.body as { label?: string };
  if (!label) return res.status(400).json({ error: "label required" });
  const { apiKey, secret } = await createApiKey(label);
  void recordAdminAction({ actor: await actorOf(req), action: "apikey.create", target: label, detail: { apiKey } });
  return res.json({ apiKey, secret });
});

/** DELETE /monitor/admin/keys/:apiKey */
router.delete("/admin/keys/:apiKey", ...modify, async (req, res) => {
  await revokeApiKey(req.params.apiKey);
  void recordAdminAction({ actor: await actorOf(req), action: "apikey.revoke", target: req.params.apiKey });
  return res.json({ ok: true });
});

/** PATCH /monitor/admin/keys/:apiKey */
router.patch("/admin/keys/:apiKey", ...modify, async (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (enabled === undefined) return res.status(400).json({ error: "enabled required" });
  await setApiKeyEnabled(req.params.apiKey, enabled);
  void recordAdminAction({ actor: await actorOf(req), action: enabled ? "apikey.enable" : "apikey.disable", target: req.params.apiKey });
  return res.json({ ok: true });
});

/**
 * POST /monitor/admin/keys/:apiKey/repair-nonce
 * Reset a single key's nonce to 0. Used by the per-row "Repair" action
 * when nonce > now wedges the key into permanent 401-replay.
 */
router.post("/admin/keys/:apiKey/repair-nonce", ...modify, async (req, res) => {
  await repairApiKeyNonce(req.params.apiKey);
  return res.json({ ok: true });
});

/**
 * POST /monitor/admin/keys/repair-nonces
 * Scan + repair every row whose nonce exceeds wall-clock ms. Returns
 * the list of repaired rows so the operator can see who was poisoned.
 */
router.post("/admin/keys/repair-nonces", ...modify, async (_req, res) => {
  const repaired = await findAndRepairBrokenNonces();
  void recordAdminAction({ actor: await actorOf(_req), action: "apikey.repair-nonces", target: null, detail: { repaired: repaired.length } });
  return res.json({ ok: true, repaired });
});

/**
 * GET /monitor/admin/actions — operator/system audit log (append-only history
 * of admin mutations). Optional ?action= and ?actor= filters, ?limit= (max 1000).
 */
router.get("/admin/actions", ...view, async (req, res) => {
  try {
    const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit as string, 10) || 200) : 200;
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const actor  = typeof req.query.actor === "string" ? req.query.actor : undefined;
    const targetPrefix = typeof req.query.targetPrefix === "string" ? req.query.targetPrefix : undefined;
    const actions = await listAdminActions({ limit, action, actor, targetPrefix });
    return res.json({
      actions: actions.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    });
  } catch (err) {
    logError("[monitor] GET /admin/actions failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ── Feeds / currency control plane ────────────────────────────────────────────

function serializeCurrency(c: Awaited<ReturnType<typeof getCurrency>>) {
  if (!c) return null;
  return {
    ...c,
    inceptionTs: c.inceptionTs ? c.inceptionTs.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** GET /monitor/currencies — list currencies + per-currency feed map. */
router.get("/currencies", ...view, async (_req, res) => {
  try {
    const currencies = await listCurrencies();
    // Days of source archive currently stored per currency (now − oldest minute),
    // for the retention preview. One grouped query.
    const daysRes = await query(
      `SELECT "currency", FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN("timestamp"))) / 86400)::int AS days
         FROM candles_1m_sources GROUP BY "currency"`,
    );
    const daysByCurrency: Record<string, number> = {};
    for (const r of daysRes.rows as { currency: string; days: number }[]) daysByCurrency[r.currency] = Number(r.days);

    const withFeeds = await Promise.all(
      currencies.map(async (c) => {
        // Per-currency backfill latch (app_settings backfillComplete:<code>) +
        // when it last flipped. null key (never onboarded) reads as not-complete.
        const latch = await getSettingMeta(`backfillComplete:${c.code}`);
        return {
          ...serializeCurrency(c)!,
          feeds: await getFeedMap(c.code),
          sourceDaysStored: daysByCurrency[c.code] ?? 0,
          backfill: {
            complete: latch?.value === "true",
            updatedAt: latch?.updatedAt ? latch.updatedAt.toISOString() : null,
          },
        };
      }),
    );
    return res.json({ currencies: withFeeds });
  } catch (err) {
    logError("[monitor] GET /currencies failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * PUT /monitor/currencies/:code — update enabled / premiumEnabled / flatFillEmpty /
 * minSources / inceptionTs. A false→true `enabled` transition onboards the currency (clears
 * the per-currency latch + kicks runBackfill behind the global in-flight guard);
 * the response reports whether that backfill `started` or was `deferred` so the
 * UI can toast it without locking the toggle.
 */
router.put("/currencies/:code", ...modify, async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const existing = await getCurrency(code);
    if (!existing) return res.status(404).json({ error: `Unknown currency '${code}'` });

    const body = req.body as {
      enabled?: boolean; premiumEnabled?: boolean; flatFillEmpty?: boolean;
      minSources?: number | null; inceptionTs?: string | null;
      sourceRetentionDays?: number | null;
    };

    if (typeof body.premiumEnabled === "boolean") await setPremiumEnabled(code, body.premiumEnabled);

    if (typeof body.flatFillEmpty === "boolean") await setFlatFillEmpty(code, body.flatFillEmpty);

    if (body.sourceRetentionDays !== undefined) {
      if (body.sourceRetentionDays !== null && (!Number.isInteger(body.sourceRetentionDays) || body.sourceRetentionDays < 1)) {
        return res.status(400).json({ error: "sourceRetentionDays must be a positive integer or null" });
      }
      await setSourceRetentionDays(code, body.sourceRetentionDays);
    }

    if (body.minSources !== undefined) {
      if (body.minSources !== null && (!Number.isInteger(body.minSources) || body.minSources < 1)) {
        return res.status(400).json({ error: "minSources must be a positive integer or null" });
      }
      await setMinSources(code, body.minSources);
    }

    if (body.inceptionTs !== undefined) {
      if (body.inceptionTs === null) {
        await setInceptionTs(code, null);
      } else {
        const d = new Date(body.inceptionTs);
        if (isNaN(d.getTime())) return res.status(400).json({ error: "inceptionTs is not a valid timestamp" });
        await setInceptionTs(code, d);
      }
    }

    let backfill: "started" | "deferred" | undefined;
    if (typeof body.enabled === "boolean") {
      await setCurrencyEnabled(code, body.enabled);
      if (body.enabled && !existing.enabled) {
        backfill = await onboardCurrency(code);   // canonical onboarding kick
      }
    }

    void recordAdminAction({
      actor: await actorOf(req),
      action: "currency.update",
      target: code,
      detail: { ...body, ...(backfill ? { backfill } : {}) },
    });

    const updated = await getCurrency(code);
    return res.json({ ok: true, currency: serializeCurrency(updated), ...(backfill ? { backfill } : {}) });
  } catch (err) {
    logError(`[monitor] PUT /currencies/${code} failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/** PUT /monitor/currencies/:code/feeds — toggle one (currency, source) feed. */
router.put("/currencies/:code/feeds", ...modify, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const body = req.body as { source?: string; enabled?: boolean };
  if (!body.source || typeof body.enabled !== "boolean") {
    return res.status(400).json({ error: "body must be { source: string, enabled: boolean }" });
  }
  try {
    const existing = await getCurrency(code);
    if (!existing) return res.status(404).json({ error: `Unknown currency '${code}'` });
    await setFeedEnabled(code, body.source, body.enabled);
    void recordAdminAction({
      actor: await actorOf(req),
      action: body.enabled ? "feed.enable" : "feed.disable",
      target: `${code}/${body.source}`,
      detail: { currency: code, source: body.source, enabled: body.enabled },
    });
    return res.json({ ok: true, feeds: await getFeedMap(code) });
  } catch (err) {
    logError(`[monitor] PUT /currencies/${code}/feeds failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /monitor/currencies/:code/probe — re-probe per-source availability for one
 * currency: fetch one recently-closed minute from each mapped venue and set
 * currency_sources.available accordingly. Availability is host-dependent
 * (D-OKX: okx is geo-blocked from some hosts), so it reflects reality for the
 * host this runs on. The deep inception fetchRange walk-back is a separate
 * probe and is intentionally not run here.
 */
router.post("/currencies/:code/probe", ...modify, async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const existing = await getCurrency(code);
    if (!existing) return res.status(404).json({ error: `Unknown currency '${code}'` });

    const probeTs = new Date(Math.floor(Date.now() / 60000) * 60000 - 3 * 60000);
    const feeds = await getFeedMap(code);
    const results = await Promise.all(
      Object.entries(feeds).map(async ([source, f]) => {
        const adapter = ADAPTER_BY_NAME[source];
        if (!adapter) return { source, available: false, error: "no adapter" };
        try {
          recordApiRequest(code, source, "probe");
          await adapter.fetchOne(f.symbol, probeTs);
          await setAvailability(code, source, true);
          return { source, available: true };
        } catch (err) {
          await setAvailability(code, source, false);
          return { source, available: false, error: String(err) };
        }
      }),
    );
    // Startup-ordering fix: the probe is what flips currency_sources.available
    // from its fresh-DB false → true. If that just gave an enabled currency its
    // first active feeds and it hasn't finished its initial backfill, kick it now
    // — this is the "re-trigger once feeds first become available" path, so the
    // boot-time backfill (which correctly deferred while no feeds were available)
    // doesn't need a process restart. onboardCurrency serializes behind the
    // global in-flight guard and is a no-op-equivalent if already running.
    let backfill: "started" | "deferred" | undefined;
    const excluded = new Set(getCurrentFormula().excludedSources);
    const activeAfter = (await getActiveFeeds(code)).filter((f) => !excluded.has(f.source));
    const backfillDone = (await getSetting(`backfillComplete:${code}`)) === "true";
    if (existing.enabled && activeAfter.length && !backfillDone) {
      backfill = await onboardCurrency(code);
    }
    void recordAdminAction({
      actor: await actorOf(req),
      action: "currency.probe",
      target: code,
      detail: { available: results.filter((r) => r.available).map((r) => r.source), ...(backfill ? { backfill } : {}) },
    });
    return res.json({ ok: true, code, probedAt: probeTs.toISOString(), results, ...(backfill ? { backfill } : {}) });
  } catch (err) {
    logError(`[monitor] POST /currencies/${code}/probe failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * Per-currency formula TIMELINE. The effective-dated record of which
 * venues compose this currency over time; repair/heal/recompose resolve it
 * as-of each minute. Distinct from the LIVE feeds (currency_sources) and the
 * GLOBAL kill-switch (formula_changes).
 */
router.get("/currencies/:code/formula-versions", ...view, async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const versions = await getFormulaTimeline(code);
    return res.json({
      versions: versions.map((v) => ({
        effectiveFrom: v.effectiveFrom.toISOString(),
        sources: v.sources,
        by: v.by,
        reason: v.reason,
        createdAt: v.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logError(`[monitor] GET /currencies/${code}/formula-versions failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/** POST /monitor/currencies/:code/formula-versions — add/replace a timeline version. */
router.post("/currencies/:code/formula-versions", ...modify, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const body = req.body as { effectiveFrom?: string; sources?: unknown; reason?: string };
  if (typeof body.effectiveFrom !== "string") {
    return res.status(400).json({ error: "effectiveFrom (ISO string) is required" });
  }
  const effectiveFrom = new Date(body.effectiveFrom);
  if (isNaN(effectiveFrom.getTime())) return res.status(400).json({ error: "effectiveFrom is not a valid timestamp" });
  if (!Array.isArray(body.sources) || !body.sources.every((s) => typeof s === "string")) {
    return res.status(400).json({ error: "sources must be string[]" });
  }
  const sources = body.sources as string[];
  if (sources.length === 0) return res.status(400).json({ error: "sources must be a non-empty venue allow-list" });
  const unknown = sources.filter((s) => !SOURCE_NAMES.includes(s));
  if (unknown.length) return res.status(400).json({ error: `Unknown source(s): ${unknown.join(", ")}` });
  try {
    const existing = await getCurrency(code);
    if (!existing) return res.status(404).json({ error: `Unknown currency '${code}'` });
    await insertFormulaVersion(code, effectiveFrom, [...new Set(sources)], await actorOf(req), body.reason ?? null);
    void recordAdminAction({
      actor: await actorOf(req),
      action: "formula.version.set",
      target: code,
      detail: { effectiveFrom: effectiveFrom.toISOString(), sources, reason: body.reason ?? null },
    });
    return res.json({ ok: true });
  } catch (err) {
    logError(`[monitor] POST /currencies/${code}/formula-versions failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/** DELETE /monitor/currencies/:code/formula-versions?effectiveFrom=ISO — remove a version. */
router.delete("/currencies/:code/formula-versions", ...modify, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const raw = req.query.effectiveFrom;
  if (typeof raw !== "string") return res.status(400).json({ error: "effectiveFrom query param (ISO) is required" });
  const effectiveFrom = new Date(raw);
  if (isNaN(effectiveFrom.getTime())) return res.status(400).json({ error: "effectiveFrom is not a valid timestamp" });
  try {
    const deleted = await deleteFormulaVersion(code, effectiveFrom);
    if (!deleted) return res.status(404).json({ error: "no version at that effectiveFrom" });
    void recordAdminAction({ actor: await actorOf(req), action: "formula.version.delete", target: code, detail: { effectiveFrom: effectiveFrom.toISOString() } });
    return res.json({ ok: true });
  } catch (err) {
    logError(`[monitor] DELETE /currencies/${code}/formula-versions failed:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /monitor/exchange-config — per-venue repair tuning + probed depths, read
 * from exchange_config.json (read-only display for the Repair Range panel's
 * advanced section; the file/CLI is the edit path).
 */
router.get("/exchange-config", ...view, (_req, res) => {
  const config: Record<string, unknown> = {};
  for (const source of SOURCE_NAMES) {
    try {
      const t = getExchangeTuning(source);
      config[source] = {
        tile_size: t.tile_size,
        throttle_ms: t.throttle_ms,
        timeout_ms: t.timeout_ms,
        candle_depth_minutes: t.candle_depth_minutes,
        peg_depth_minutes: t.peg_depth_minutes,
      };
    } catch {
      config[source] = null; // not in the config file
    }
  }
  return res.json({ config });
});

export default router;
