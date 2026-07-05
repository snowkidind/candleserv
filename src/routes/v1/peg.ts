import { Router } from "express";
import { tfToMinutes, VALID_TFS } from "../../db/candles.js";
import { getLatestPegRates, getPegBuckets, getPegPresence } from "../../db/stableRates.js";
import type { PegBar } from "../../db/stableRates.js";
import { PEG_SOURCE_NAMES, PEG_SOURCE_PAIRS } from "../../adapters/registry.js";
import { logError } from "../../lib/log.js";

/**
 * GET /v1/peg — per-venue USDT→USD peg rates from stable_rates_1m_sources.
 *
 * A read-only sibling of the premium trio over data candleserv already
 * collects. USDT-only over four peg venues (binance/bybit/gate/bitget); no
 * USDC (not tracked) and no kraken/coinbase peg (USD-native, no peg row). All
 * three routes SELECT-only; no persistence, no new tracking.
 *
 * Mounted at /v1/peg; routes below are relative (/now, /, /venues). Auth is
 * applied once at the /v1 boundary (app.use("/v1", apiKeyAuth)) — this router
 * registers NO auth of its own and NO premiumRateLimit (that guard is
 * premium-only; peg reads are light indexed SELECTs, not on-the-fly compute).
 */
const router = Router();

// 30d is a calendar-month aggregation that doesn't fit the rolling window here
// (mirrors premium's exclusion).
const PEG_TFS = VALID_TFS.filter((t) => t !== "30d");

// Hard cap on buckets per venue per response (mirrors the candle/premium endpoints).
const MAX_BARS = 5000;

/**
 * GET /v1/peg/now — the immediate per-venue USDT→USD peg at the last closed
 * minute. Missing venues are omitted (fail-visible), never backfilled with a
 * stale value.
 *
 * Response: { unit:"usd", USDT: { <venue>: <rate> }, timestamp: <unix ms|null> }
 */
router.get("/now", async (_req, res) => {
  try {
    const result = await getLatestPegRates();
    const USDT = Object.fromEntries(result.rates.map((r) => [r.source, r.rate]));
    return res.json({
      unit: "usd",
      USDT,
      timestamp: result.timestamp ? result.timestamp.getTime() : null,
    });
  } catch (err) {
    logError("[v1/peg] GET /peg/now failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /v1/peg?tf=1h&endingAt=<iso>&limit=200&venue=<name> — OHLC-of-rate
 * history per venue. Serves raw OHLC of the per-minute rate (consumer averages
 * downstream). Omit `venue` for all venues; pass one to filter.
 *
 * Response: { unit:"usd", tf, USDT: { <venue>: [{t,o,h,l,c,n}, ...] } }
 */
router.get("/", async (req, res) => {
  const tf = (req.query.tf as string) || "1h";
  if (!PEG_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${PEG_TFS.join(", ")}` });
  }

  const endingAt = req.query.endingAt ? new Date(req.query.endingAt as string) : new Date();
  if (isNaN(endingAt.getTime())) return res.status(400).json({ error: "Invalid endingAt" });

  const limit = Math.min(Math.max((parseInt(req.query.limit as string, 10) || 200), 1), MAX_BARS);

  let venue: string | undefined;
  if (typeof req.query.venue === "string" && req.query.venue.trim()) {
    venue = req.query.venue.trim().toLowerCase();
    if (!PEG_SOURCE_NAMES.includes(venue)) {
      return res.status(400).json({ error: `Unknown peg venue '${venue}'. Known: ${PEG_SOURCE_NAMES.join(", ")}` });
    }
  }

  const mins = tfToMinutes(tf);
  const from = new Date(endingAt.getTime() - mins * limit * 60_000);
  const to = new Date(endingAt.getTime() + 1);

  try {
    const bars = await getPegBuckets(mins, from, to, venue);
    const bySource: Record<string, Omit<PegBar, "source">[]> = {};
    for (const b of bars) {
      (bySource[b.source] ??= []).push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, n: b.n });
    }
    // Trim each venue to the last `limit` buckets (no global SQL LIMIT — that
    // would starve later-sorted venues).
    for (const s of Object.keys(bySource)) {
      if (bySource[s].length > limit) bySource[s] = bySource[s].slice(-limit);
    }
    return res.json({ unit: "usd", tf, USDT: bySource });
  } catch (err) {
    logError("[v1/peg] GET /peg failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /v1/peg/venues — the four peg venues, each with its pegSourcePair
 * provenance and archived-rate coverage window (unix ms).
 */
router.get("/venues", async (_req, res) => {
  try {
    const presence = await getPegPresence();
    const bySource = new Map(presence.map((p) => [p.source, p]));
    const venues = PEG_SOURCE_NAMES.map((name) => {
      const p = bySource.get(name);
      return {
        name,
        pegSourcePair: PEG_SOURCE_PAIRS[name],
        hasData: p != null && p.count > 0,
        oldest: p?.oldest ?? null,
        newest: p?.newest ?? null,
        count: p?.count ?? 0,
      };
    });
    return res.json({ venues });
  } catch (err) {
    logError("[v1/peg] GET /peg/venues failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
