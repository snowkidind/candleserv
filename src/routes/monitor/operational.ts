import { Router } from "express";
import { trackSession, authenticate, requirePerm } from "../../middleware/sessionAuth.js";
import { query } from "../../db/pool.js";
import { getAllGaps, countPendingGaps } from "../../db/gaps.js";
import { getStreamEvents } from "../../db/streamEvents.js";
import { getAllSettings, setSetting } from "../../db/appSettings.js";
import { getCandles, getCollectionLatencyStats, VALID_TFS } from "../../db/candles.js";
import { runGapScan } from "../../lib/gapDetector.js";
import { getSourceStatus, resumeSource } from "../../lib/collector.js";
import {
  listApiKeys, createApiKey, revokeApiKey, setApiKeyEnabled,
  repairApiKeyNonce, findAndRepairBrokenNonces,
} from "../../db/apiKeys.js";
import { getAllServiceEvents } from "../../db/serviceEvents.js";
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

/** POST /monitor/sources/:source/resume */
router.post("/sources/:source/resume", ...modify, (req, res) => {
  resumeSource(req.params.source);
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
