import { Router } from "express";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { getCandles, getLatest1m, VALID_TFS } from "../../db/candles.js";
import { addClient, removeClient, getSubscriptionStatus, pushToClient } from "../../lib/subscriptions.js";
import { candleEmitter } from "../../lib/emitter.js";
import { redisGet, redisSet, boundaryTtl } from "../../lib/redis.js";
import type { SseClient } from "../../types/index.js";

const router = Router();

// All /v1/* routes require API key auth
router.use(apiKeyAuth);

/**
 * GET /v1/candles/latest?tf=<tf>&n=<count>
 */
router.get("/candles/latest", async (req, res) => {
  const { tf, n } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${VALID_TFS.join(", ")}` });
  }
  const count = Math.min(parseInt(n, 10) || 1, 5000);
  const cacheKey = `candles:latest:${tf}:${count}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const candles = await getCandles({ tf, endingAt: new Date(), limit: count });
    const payload = { candles };
    await redisSet(cacheKey, JSON.stringify(payload), boundaryTtl(tf));
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /v1/candles?tf=<tf>&endingAt=<iso>&limit=<n>
 */
router.get("/candles", async (req, res) => {
  const { tf, endingAt, limit } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${VALID_TFS.join(", ")}` });
  }
  if (!endingAt) return res.status(400).json({ error: "endingAt is required" });
  const endDate = new Date(endingAt);
  if (isNaN(endDate.getTime())) return res.status(400).json({ error: "Invalid endingAt" });
  const n = Math.min(parseInt(limit, 10) || 100, 5000);
  const cacheKey = `candles:${tf}:${endDate.getTime()}:${n}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const candles = await getCandles({ tf, endingAt: endDate, limit: n });
    const payload = { candles };
    await redisSet(cacheKey, JSON.stringify(payload), boundaryTtl(tf, endDate));
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /v1/candles/stream?n=<count>
 * SSE — 1m only, rolling N-candle buffer per push.
 */
router.get("/candles/stream", async (req, res) => {
  const apiKey = req.apiKey!;
  const n = Math.min(Math.max(parseInt((req.query.n as string) || "1", 10), 1), 200);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client: SseClient = {
    apiKeyId: req.apiKeyId!,
    apiKey,
    n,
    res,
    connectedSince: new Date(),
    lastPushAt: null,
  };
  addClient(client);

  // Initial push — send the last N candles immediately
  try {
    const initial = await getLatest1m(n);
    res.write(`event: candles\ndata: ${JSON.stringify({ candles: initial, count: initial.length })}\n\n`);
    client.lastPushAt = new Date();
  } catch {
    // Non-fatal — client will get candles on next push
  }

  // Fan-out: when a new candle arrives, push last N to this client
  const onCandle = async () => {
    try {
      const candles = await getLatest1m(n);
      pushToClient(apiKey, candles);
    } catch {
      // ignore
    }
  };

  candleEmitter.on("candle", onCandle);

  req.on("close", () => {
    candleEmitter.off("candle", onCandle);
    removeClient(apiKey);
  });
});

/**
 * GET /v1/candles/subscriptions
 * Check if this API key has an active SSE subscription.
 */
router.get("/candles/subscriptions", (req, res) => {
  const status = getSubscriptionStatus(req.apiKey!);
  return res.json(status);
});

export default router;
