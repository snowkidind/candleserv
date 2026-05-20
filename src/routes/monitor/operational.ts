import { Router } from "express";
import { trackSession, authenticate, requirePerm } from "../../middleware/sessionAuth.js";
import { query } from "../../db/pool.js";
import { getAllGaps, countPendingGaps } from "../../db/gaps.js";
import { getStreamEvents } from "../../db/streamEvents.js";
import { getAllSettings, setSetting } from "../../db/appSettings.js";
import { get24hSourceStats, getCandles, getCollectionLatencyStats, VALID_TFS } from "../../db/candles.js";
import { runGapScan } from "../../lib/gapDetector.js";
import { getSourceStatus, resumeSource } from "../../lib/collector.js";
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
  startRepairJob, previewRepair, getRepairJob, cancelRepairJob,
  isRepairInProgress, validateRepairWindow,
} from "../../lib/repairJobs.js";
import { logError } from "../../lib/log.js";

const router = Router();
const view   = [trackSession, authenticate, requirePerm("CAN_VIEW_CANDLESERV")];
const modify = [trackSession, authenticate, requirePerm("CAN_MODIFY_CANDLESERV")];

/** GET /monitor/candles?tf=<tf>&endingAt=<iso>&limit=<n> — historical page for monitor chart */
router.get("/candles", ...view, async (req, res) => {
  const { tf, endingAt, limit } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) return res.status(400).json({ error: "Invalid tf" });
  if (!endingAt) return res.status(400).json({ error: "endingAt required" });
  const end = new Date(endingAt);
  if (isNaN(end.getTime())) return res.status(400).json({ error: "Invalid endingAt" });
  const count = Math.min(parseInt(limit, 10) || 500, 2000);
  try {
    const candles = await getCandles({ tf, endingAt: end, limit: count });
    return res.json({ candles });
  } catch (err) {
    logError("[monitor] GET /candles failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/candles/latest?tf=<tf>&n=<n> — session auth, for monitor UI */
router.get("/candles/latest", ...view, async (req, res) => {
  const { tf, n } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) return res.status(400).json({ error: "Invalid tf" });
  const count = Math.min(parseInt(n, 10) || 1, 5000);
  try {
    const candles = await getCandles({ tf, endingAt: new Date(), limit: count });
    return res.json({ candles });
  } catch (err) {
    logError("[monitor] GET /candles/latest failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /monitor/gaps */
router.get("/gaps", ...view, async (_req, res) => {
  const gaps = await getAllGaps(200);
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
  runGapScan(7).catch((err) => logError("[monitor] POST /heal runGapScan failed:", err));
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
      getCollectionLatencyStats(60),
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
router.get("/sources/status", ...view, async (_req, res) => {
  const status = getSourceStatus();
  return res.json({ sources: status });
});

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
router.get("/formula", ...view, (_req, res) => {
  return res.json({
    excludedSources: getCurrentFormula().excludedSources,
    lastChange: lastChangePayload(),
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
 *   body: { from: ISO, to: ISO, sources?: string[], formula?: { excludedSources: string[] }, retryEmpty?: boolean }
 *
 * dry=true returns { preview }. dry=false starts a job and returns { jobId }.
 * Single-flight: rejects with 409 if a job is already running.
 *
 * Window guards (validateRepairWindow):
 *   from ≥ NOW() - 180d
 *   to   ≤ floor(NOW() to minute) - 1m  (never touches the in-progress minute)
 */
router.post("/repair", ...modify, async (req, res) => {
  const body = req.body as {
    from?: string;
    to?: string;
    sources?: unknown;
    formula?: { excludedSources?: unknown };
    retryEmpty?: unknown;
  };
  if (typeof body?.from !== "string" || typeof body?.to !== "string") {
    return res.status(400).json({ error: "Body must include from + to (ISO strings)" });
  }
  const from = new Date(body.from);
  const to   = new Date(body.to);
  const winErr = validateRepairWindow(from, to);
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

  const retryEmpty = Boolean(body.retryEmpty);
  const dry = req.query.dry === "true";

  if (dry) {
    try {
      const preview = await previewRepair({ from, to, sources, formula, retryEmpty });
      return res.json({ preview });
    } catch (err) {
      logError("[monitor] POST /repair?dry=true failed:", err);
      return res.status(500).json({ error: String(err) });
    }
  }

  // Wet run — single-flight check + start job.
  if (isRepairInProgress()) {
    return res.status(409).json({ error: "a repair job is already in progress" });
  }
  try {
    const { jobId } = startRepairJob({ from, to, sources, formula, retryEmpty });
    return res.json({ jobId });
  } catch (err) {
    logError("[monitor] POST /repair start failed:", err);
    return res.status(500).json({ error: String(err) });
  }
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
 * POST /monitor/sources/:source/resume — legacy endpoint. Phase 3 of the
 * exchange-expansion plan replaced the in-memory pause set with the formula
 * model; this endpoint now routes to insertFormulaChange('unset') so the old
 * "Resume" button keeps working. Phase 6 frontend lands the rename to
 * PUT /monitor/formula and the endpoint is removed.
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
  return res.json({ ok: true });
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
  return res.json({ apiKey, secret });
});

/** DELETE /monitor/admin/keys/:apiKey */
router.delete("/admin/keys/:apiKey", ...modify, async (req, res) => {
  await revokeApiKey(req.params.apiKey);
  return res.json({ ok: true });
});

/** PATCH /monitor/admin/keys/:apiKey */
router.patch("/admin/keys/:apiKey", ...modify, async (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (enabled === undefined) return res.status(400).json({ error: "enabled required" });
  await setApiKeyEnabled(req.params.apiKey, enabled);
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
  return res.json({ ok: true, repaired });
});

export default router;
