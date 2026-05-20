import { Router } from "express";
import { apiKeyAuth } from "../../middleware/apiKeyAuth.js";
import { getCandles, getLatest1m, tfToMinutes, VALID_TFS } from "../../db/candles.js";
import { addClient, removeClient, getSubscriptionStatus, pushToClient } from "../../lib/subscriptions.js";
import { candleEmitter } from "../../lib/emitter.js";
import { redisGet, redisSet, boundaryTtl } from "../../lib/redis.js";
import { log, logError } from "../../lib/log.js";
import type { CandleJson, SseClient } from "../../types/index.js";

const WAIT_FOR_FRESH_TFS = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "6h", "1d", "7d"]);
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_LIMIT_MS = 60_000;

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
 * GET /v1/candles?tf=<tf>&endingAt=<iso>&limit=<n>&waitForFresh=<bool>&maxWaitMs=<n>
 *
 * When waitForFresh=true, the response is held until a 1m candle whose close
 * timestamp is at-or-after endingAt has been ingested, or until maxWaitMs
 * elapses (504). See plans/candleserv-wait-for-fresh.md.
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

  const waitForFresh = req.query.waitForFresh === "true";
  if (waitForFresh) {
    return handleWaitForFresh(req, res, tf, endDate, n);
  }

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
 * POST /v1/candles/multi
 *
 * Body: { requests: [{ tf, endingAt, limit }, ...] }
 *
 * Batched read so phaseserv's /phase/current/bundle (and any consumer that
 * needs N timeframes at once) issues a single auth/nonce pair instead of N.
 * That prevents the multi-call nonce-race scenario where parallel single-TF
 * fetches could lap each other across replicas. waitForFresh is intentionally
 * not supported here — bundle path doesn't use it, cron is sequential.
 *
 * Semantics: all-or-nothing. Any validation or fetch failure 4xx/5xx's the
 * whole batch with the offending entry index. Per-request redis cache is
 * still consulted so a mixed cache state benefits the batch the same way it
 * benefits single-TF calls.
 *
 * Response: { results: [{ tf, endingAt, candles }, ...] } in input order.
 */
const MAX_BATCH_SIZE = 16;
const MAX_LIMIT_PER_ENTRY = 5000;

interface MultiEntry {
  tf: string;
  endingAt: string;
  limit: number;
}

router.post("/candles/multi", async (req, res) => {
  const body = req.body as { requests?: unknown };
  if (!body || !Array.isArray(body.requests)) {
    return res.status(400).json({ error: "body must be { requests: [...] }" });
  }
  if (body.requests.length === 0) {
    return res.status(400).json({ error: "requests must be non-empty" });
  }
  if (body.requests.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ error: `requests exceeds max batch size of ${MAX_BATCH_SIZE}` });
  }

  const validated: Array<{ tf: string; endDate: Date; n: number }> = [];
  for (let i = 0; i < body.requests.length; i++) {
    const entry = body.requests[i] as Partial<MultiEntry>;
    if (!entry || typeof entry.tf !== "string" || !VALID_TFS.includes(entry.tf)) {
      return res.status(400).json({ error: `requests[${i}].tf invalid (valid: ${VALID_TFS.join(", ")})` });
    }
    if (typeof entry.endingAt !== "string") {
      return res.status(400).json({ error: `requests[${i}].endingAt is required` });
    }
    const endDate = new Date(entry.endingAt);
    if (isNaN(endDate.getTime())) {
      return res.status(400).json({ error: `requests[${i}].endingAt is not a valid date` });
    }
    if (typeof entry.limit !== "number" || !Number.isInteger(entry.limit) || entry.limit <= 0) {
      return res.status(400).json({ error: `requests[${i}].limit must be a positive integer` });
    }
    const n = Math.min(entry.limit, MAX_LIMIT_PER_ENTRY);
    validated.push({ tf: entry.tf, endDate, n });
  }

  try {
    const results = await Promise.all(
      validated.map(async ({ tf, endDate, n }) => {
        const cacheKey = `candles:${tf}:${endDate.getTime()}:${n}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as { candles: CandleJson[] };
          return { tf, endingAt: endDate.toISOString(), candles: parsed.candles };
        }
        const candles = await getCandles({ tf, endingAt: endDate, limit: n });
        await redisSet(cacheKey, JSON.stringify({ candles }), boundaryTtl(tf, endDate));
        return { tf, endingAt: endDate.toISOString(), candles };
      }),
    );
    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

async function handleWaitForFresh(
  req: import("express").Request,
  res: import("express").Response,
  tf: string,
  endDate: Date,
  n: number,
): Promise<void> {
  if (!WAIT_FOR_FRESH_TFS.has(tf)) {
    res.status(400).json({
      error: `waitForFresh not supported for tf=${tf}`,
      supported: [...WAIT_FOR_FRESH_TFS],
    });
    return;
  }

  const tfMs = tfToMinutes(tf) * 60_000;
  const endMs = endDate.getTime();
  if (endMs % tfMs !== 0) {
    res.status(400).json({
      error: "endingAt must align with tf boundary when waitForFresh=true",
      tf,
      endingAt: endDate.toISOString(),
    });
    return;
  }

  const rawMaxWait = req.query.maxWaitMs as string | undefined;
  const requestedMaxWait = rawMaxWait != null ? parseInt(rawMaxWait, 10) : DEFAULT_WAIT_MS;
  if (isNaN(requestedMaxWait) || requestedMaxWait < 0) {
    res.status(400).json({ error: "maxWaitMs must be a non-negative integer" });
    return;
  }
  const maxWait = Math.min(requestedMaxWait, MAX_WAIT_LIMIT_MS);

  // The bar that closes at endMs has 1m open-time = endMs - 60_000 in candles_1m.
  // Once that 1m row exists, the requested-tf bucket is fully populated under
  // sequential live ingest.
  const requiredMinuteOpenMs = endMs - 60_000;

  let resolved = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    candleEmitter.off("candle", onCandle);
    if (timer) clearTimeout(timer);
  };

  const finish = (status: number, body: unknown) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    res.status(status).json(body);
  };

  async function onCandle(json: CandleJson): Promise<void> {
    if (resolved) return;
    if (json.timestamp < requiredMinuteOpenMs) return;
    try {
      const candles = await getCandles({ tf, endingAt: endDate, limit: n });
      finish(200, { candles });
    } catch (err) {
      logError("[waitForFresh] fetch on insert failed:", err);
      finish(500, { error: String(err) });
    }
  }

  candleEmitter.on("candle", onCandle);

  timer = setTimeout(async () => {
    if (resolved) return;
    let lastAvailableTs: number | null = null;
    try {
      const last = await getLatest1m(1);
      lastAvailableTs = last.length ? last[0].timestamp : null;
    } catch (err) {
      logError("[waitForFresh] timeout latest1m fetch failed:", err);
    }
    finish(504, {
      error: "candle not available within maxWaitMs",
      tf,
      endingAt: endDate.toISOString(),
      lastAvailableTs,
      waitedMs: maxWait,
    });
  }, maxWait);

  req.on("close", () => {
    if (resolved) return;
    resolved = true;
    cleanup();
    log(`[waitForFresh] caller disconnected — cleaned up tf=${tf} endingAt=${endDate.toISOString()}`);
  });

  // Fast path runs after listener is attached so an insert during the query
  // can't slip past us.
  try {
    const latest = await getLatest1m(1);
    const latestTs = latest.length ? latest[0].timestamp : -Infinity;
    if (latestTs >= requiredMinuteOpenMs) {
      const candles = await getCandles({ tf, endingAt: endDate, limit: n });
      finish(200, { candles });
    }
  } catch (err) {
    logError("[waitForFresh] fast path failed:", err);
    finish(500, { error: String(err) });
  }
}

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
