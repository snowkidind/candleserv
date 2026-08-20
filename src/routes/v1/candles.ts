import { Router } from "express";
import { getCandles, getLatest1m, tfToMinutes, VALID_TFS } from "../../db/candles.js";
import { getEnabledCurrencies, canonicalCurrency } from "../../db/currencies.js";
import { addClient, removeClient, getSubscriptionStatus, pushToClient } from "../../lib/subscriptions.js";
import { candleEmitter } from "../../lib/emitter.js";
import { redisGet, redisSet, boundaryTtl } from "../../lib/redis.js";
import { log, logError } from "../../lib/log.js";
import type { CandleJson, SseClient } from "../../types/index.js";

const WAIT_FOR_FRESH_TFS = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "6h", "1d", "7d"]);
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_LIMIT_MS = 60_000;

// SSE keepalive cadence. Candle frames arrive ~once/minute, so without a heartbeat
// a silently-dead (proxy half-open / partition) connection is indistinguishable
// from "no candle yet" for ~60s. A NAMED heartbeat event (not a `:` comment, which
// some clients never surface) lets a consumer's idle watchdog detect death within
// a few missed beats. Mirrors hotphase's events.routes.
const STREAM_HEARTBEAT_MS = 20_000;

const router = Router();

// Auth is applied once at the /v1 boundary (app.use("/v1", apiKeyAuth)) — this
// router is mounted at the disjoint /v1/candles prefix and registers no auth of
// its own (a per-router router.use of the stateful apiKeyAuth would double-run
// the single-use nonce under a shared mount).

/**
 * Resolve + validate the ?currency param. Defaults to BTC — the
 * pre-multi-currency consumers send no currency and must keep getting BTC
 * unchanged. Returns the validated uppercase code or an error for a 400.
 */
async function resolveCurrency(raw: unknown): Promise<{ currency: string } | { error: string }> {
  const currency = canonicalCurrency(raw);
  const enabled = await getEnabledCurrencies();
  if (!enabled.includes(currency)) {
    return { error: `Unknown or disabled currency '${currency}'. Enabled: ${enabled.join(", ")}` };
  }
  return { currency };
}

/**
 * Resolve + validate a comma-separated ?currency list for the multi-currency
 * stream (e.g. ?currency=BTC,ETH,SOL). Each code is validated via resolveCurrency;
 * any invalid code fails the whole request (fail loud). Deduped, order preserved.
 * Empty/absent ⇒ [BTC] (the resolveCurrency default). Returns the validated set or
 * an error for a 400.
 */
async function resolveCurrencies(raw: unknown): Promise<{ currencies: string[] } | { error: string }> {
  const codes = typeof raw === "string" && raw.length > 0
    ? raw.split(",").map((c) => c.trim()).filter((c) => c.length > 0)
    : [undefined]; // undefined ⇒ resolveCurrency default (BTC)
  const out: string[] = [];
  for (const code of codes) {
    const resolved = await resolveCurrency(code);
    if ("error" in resolved) return { error: resolved.error };
    if (!out.includes(resolved.currency)) out.push(resolved.currency);
  }
  return { currencies: out };
}

/**
 * GET /v1/candles/latest?tf=<tf>&n=<count>
 */
router.get("/latest", async (req, res) => {
  const { tf, n } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${VALID_TFS.join(", ")}` });
  }
  const resolved = await resolveCurrency(req.query.currency);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const { currency } = resolved;
  const count = Math.min(parseInt(n, 10) || 1, 5000);
  const cacheKey = `candles:latest:${currency}:${tf}:${count}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const candles = await getCandles({ currency, tf, endingAt: new Date(), limit: count });
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
 * elapses (504).
 */
router.get("/", async (req, res) => {
  const { tf, endingAt, limit } = req.query as Record<string, string>;
  if (!tf || !VALID_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${VALID_TFS.join(", ")}` });
  }
  if (!endingAt) return res.status(400).json({ error: "endingAt is required" });
  const endDate = new Date(endingAt);
  if (isNaN(endDate.getTime())) return res.status(400).json({ error: "Invalid endingAt" });
  const n = Math.min(parseInt(limit, 10) || 100, 5000);

  const resolved = await resolveCurrency(req.query.currency);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const { currency } = resolved;

  const waitForFresh = req.query.waitForFresh === "true";
  if (waitForFresh) {
    return handleWaitForFresh(req, res, currency, tf, endDate, n);
  }

  const cacheKey = `candles:${currency}:${tf}:${endDate.getTime()}:${n}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const candles = await getCandles({ currency, tf, endingAt: endDate, limit: n });
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
  currency?: string;
}

router.post("/multi", async (req, res) => {
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

  const validated: Array<{ tf: string; endDate: Date; n: number; currency: string }> = [];
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
    const resolved = await resolveCurrency(entry.currency);
    if ("error" in resolved) return res.status(400).json({ error: `requests[${i}].currency: ${resolved.error}` });
    const n = Math.min(entry.limit, MAX_LIMIT_PER_ENTRY);
    validated.push({ tf: entry.tf, endDate, n, currency: resolved.currency });
  }

  try {
    const results = await Promise.all(
      validated.map(async ({ tf, endDate, n, currency }) => {
        const cacheKey = `candles:${currency}:${tf}:${endDate.getTime()}:${n}`;
        const cached = await redisGet(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as { candles: CandleJson[] };
          return { tf, currency, endingAt: endDate.toISOString(), candles: parsed.candles };
        }
        const candles = await getCandles({ currency, tf, endingAt: endDate, limit: n });
        await redisSet(cacheKey, JSON.stringify({ candles }), boundaryTtl(tf, endDate));
        return { tf, currency, endingAt: endDate.toISOString(), candles };
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
  currency: string,
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
    candleEmitter.off("__close__", onClose);
    if (timer) clearTimeout(timer);
  };

  const finish = (status: number, body: unknown) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    res.status(status).json(body);
  };

  async function onCandle(json: CandleJson & { currency?: string }): Promise<void> {
    if (resolved) return;
    if ((json.currency ?? "BTC") !== currency) return;
    if (json.timestamp < requiredMinuteOpenMs) return;
    try {
      const candles = await getCandles({ currency, tf, endingAt: endDate, limit: n });
      finish(200, { candles });
    } catch (err) {
      logError("[waitForFresh] fetch on insert failed:", err);
      finish(500, { error: String(err) });
    }
  }

  // Repair-job drain: when closeAllListeners fires '__close__', any in-flight
  // waitForFresh waiters finish with 503 (matches the repair-lock middleware
  // semantics — service unavailable for candle reads during repair). Mirrors
  // the timeout response shape.
  async function onClose(): Promise<void> {
    if (resolved) return;
    let lastAvailableTs: number | null = null;
    try {
      const last = await getLatest1m(currency, 1);
      lastAvailableTs = last.length ? last[0].timestamp : null;
    } catch {}
    finish(503, {
      error: "repair in progress",
      tf,
      endingAt: endDate.toISOString(),
      lastAvailableTs,
    });
  }

  candleEmitter.on("candle", onCandle);
  candleEmitter.on("__close__", onClose);

  timer = setTimeout(async () => {
    if (resolved) return;
    let lastAvailableTs: number | null = null;
    try {
      const last = await getLatest1m(currency, 1);
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
    const latest = await getLatest1m(currency, 1);
    const latestTs = latest.length ? latest[0].timestamp : -Infinity;
    if (latestTs >= requiredMinuteOpenMs) {
      const candles = await getCandles({ currency, tf, endingAt: endDate, limit: n });
      finish(200, { candles });
    }
  } catch (err) {
    logError("[waitForFresh] fast path failed:", err);
    finish(500, { error: String(err) });
  }
}

/**
 * GET /v1/candles/stream?currency=<BTC[,ETH,...]>&n=<count>
 * SSE — 1m only, rolling N-candle buffer per push. One connection may subscribe to
 * multiple currencies (comma-separated); each frame is tagged with its currency:
 *   event: candles
 *   data: { "currency": "BTC", "candles": [ … ], "count": 5 }
 */
router.get("/stream", async (req, res) => {
  const apiKey = req.apiKey!;
  const n = Math.min(Math.max(parseInt((req.query.n as string) || "1", 10), 1), 200);

  const resolved = await resolveCurrencies(req.query.currency);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const { currencies } = resolved;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
  res.flushHeaders();
  res.write("retry: 3000\n\n");   // client reconnect backoff hint
  res.write(": connected\n\n");   // SSE open comment

  const client: SseClient = {
    apiKeyId: req.apiKeyId!,
    apiKey,
    n,
    currencies,
    res,
    connectedSince: new Date(),
    lastPushAt: null,
  };
  addClient(client);

  // Named heartbeat (not a `:` comment) so a consumer's idle watchdog sees liveness
  // between the ~once/minute candle frames. Written directly to res; cleared on close.
  const heartbeat = setInterval(() => {
    try { res.write("event: heartbeat\ndata: {}\n\n"); } catch { /* dropped — cleanup fires on close/error */ }
  }, STREAM_HEARTBEAT_MS);

  // Initial push — one tagged frame per subscribed currency (last N each).
  for (const currency of currencies) {
    try {
      const initial = await getLatest1m(currency, n);
      res.write(`event: candles\ndata: ${JSON.stringify({ currency, candles: initial, count: initial.length })}\n\n`);
      client.lastPushAt = new Date();
    } catch {
      // Non-fatal — client will get this currency's candles on its next push
    }
  }

  // Fan-out: on each new candle, push last N to this client — but only for a
  // currency it subscribes to, so an unsubscribed tick never wakes this stream.
  const onCandle = async (candle: CandleJson & { currency?: string }) => {
    const cur = candle?.currency ?? "BTC";
    if (!currencies.includes(cur)) return;
    try {
      const candles = await getLatest1m(cur, n);
      pushToClient(apiKey, cur, candles);
    } catch {
      // ignore
    }
  };

  candleEmitter.on("candle", onCandle);

  req.on("close", () => {
    clearInterval(heartbeat);
    candleEmitter.off("candle", onCandle);
    removeClient(apiKey);
  });
});

/**
 * GET /v1/candles/subscriptions
 * Check if this API key has an active SSE subscription.
 */
router.get("/subscriptions", (req, res) => {
  const status = getSubscriptionStatus(req.apiKey!);
  return res.json(status);
});

export default router;
