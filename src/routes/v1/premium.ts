import { Router } from "express";
import { premiumRateLimit } from "../../middleware/premiumRateLimit.js";
import { getSourceCandles, getSourcePresence, tfToMinutes, VALID_TFS } from "../../db/candles.js";
import { getEnabledCurrencies, canonicalCurrency } from "../../db/currencies.js";
import { SOURCE_NAMES } from "../../adapters/registry.js";
import { computeMinuteOffsets, aggregateOffsets, isPegVenue } from "../../lib/premium.js";
import { logError } from "../../lib/log.js";

/**
 * GET /v1/premium — per-venue cross-exchange premium-offset history.
 *
 * Surfaces the signed-USD leave-one-out premium offset (research/methods #12)
 * as an OHLC-of-offset series per venue, computed on the fly from the archived
 * per-source candles + paired stable rates. No persistence, no frontend — a
 * read-only history of the basis signal that buildComposite discards internally.
 * The bitfinex slice is the headline (USD-native venue → its whole basis lands
 * in the offset). See chit/articles/01_bitfinex_premium and method #12.
 *
 * Auth: API key (same as /v1/candles). Rate-limit: demo-style per-key sliding
 * 60s window (premiumRateLimit).
 */
const router = Router();

// Auth runs once at the /v1 boundary (app.use("/v1", apiKeyAuth)); this router
// is mounted at the disjoint /v1/premium prefix. premiumRateLimit stays here —
// it is premium-only and now correctly scoped to /v1/premium (under the old
// shared /v1 mount it leaked onto sibling routers via fall-through).
router.use(premiumRateLimit);

// 30d is a calendar-month aggregation that doesn't fit the rolling window here.
const PREMIUM_TFS = VALID_TFS.filter((t) => t !== "30d");

// Hard cap on buckets per response (mirrors the candle endpoints' 5000).
const MAX_BARS = 5000;
// Hard cap on raw 1m source-minutes pulled+aggregated per request (~93 days).
// Bounds memory: at higher TFs this lets ~90d through (1d×93, 1h×2232); at 1m
// it's the MAX_BARS cap that bites first (~3.5 days in one call).
const MAX_RAW_MINUTES = 134_000;

async function resolveCurrency(raw: unknown): Promise<{ currency: string } | { error: string }> {
  const currency = canonicalCurrency(raw);
  const enabled = await getEnabledCurrencies();
  if (!enabled.includes(currency)) {
    return { error: `Unknown or disabled currency '${currency}'. Enabled: ${enabled.join(", ")}` };
  }
  return { currency };
}

/**
 * GET /v1/premium?currency=BTC&tf=1h&endingAt=<iso>&limit=200&venue=<name>
 *
 * Response: { currency, tf, unit:"usd", venues: { <venue>: [{t,o,h,l,c,n}, ...] } }
 *   - t: bucket-open unix ms
 *   - o/h/l/c: OHLC of the per-minute premium offset (signed USD), where the
 *     wick (h/l) is the widest/narrowest the basis got intraday
 *   - n: contributing minutes in the bucket
 * Omit `venue` for all venues; pass one venue name to filter.
 */
router.get("/", async (req, res) => {
  const tf = (req.query.tf as string) || "1m";
  if (!PREMIUM_TFS.includes(tf)) {
    return res.status(400).json({ error: `Invalid tf. Valid: ${PREMIUM_TFS.join(", ")}` });
  }

  const resolved = await resolveCurrency(req.query.currency);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const { currency } = resolved;

  let venueFilter: string | undefined;
  if (typeof req.query.venue === "string" && req.query.venue.trim()) {
    venueFilter = req.query.venue.trim().toLowerCase();
    if (!SOURCE_NAMES.includes(venueFilter)) {
      return res.status(400).json({ error: `Unknown venue '${venueFilter}'. Known: ${SOURCE_NAMES.join(", ")}` });
    }
  }

  const endingAt = req.query.endingAt ? new Date(req.query.endingAt as string) : new Date();
  if (isNaN(endingAt.getTime())) return res.status(400).json({ error: "Invalid endingAt" });

  const tfMin = tfToMinutes(tf);
  const requested = parseInt(req.query.limit as string, 10);
  // Cap bars by MAX_BARS and by the raw-minute budget for this tf.
  const barCap = Math.min(MAX_BARS, Math.max(1, Math.floor(MAX_RAW_MINUTES / tfMin)));
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 200, barCap);

  // Pull one tf*limit window of 1m source rows ending at endingAt (inclusive).
  const from = new Date(endingAt.getTime() - tfMin * limit * 60_000);
  const to = new Date(endingAt.getTime() + 1);

  try {
    const rows = await getSourceCandles(currency, from, to);
    const offsets = computeMinuteOffsets(rows);

    const venues: Record<string, ReturnType<typeof aggregateOffsets>> = {};
    const names = venueFilter ? [venueFilter] : SOURCE_NAMES;
    for (const name of names) {
      const series = offsets.get(name);
      if (!series || series.length === 0) {
        if (venueFilter) venues[name] = [];
        continue;
      }
      venues[name] = aggregateOffsets(series, tfMin, limit);
    }

    return res.json({ currency, tf, unit: "usd", venues });
  } catch (err) {
    logError("[v1/premium] GET /premium failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /v1/premium/venues?currency=BTC — which venues have derivable premium
 * history, whether they're peg-corrected (USDT) or USD-native, and the coverage
 * window of their archived source data.
 */
router.get("/venues", async (req, res) => {
  const resolved = await resolveCurrency(req.query.currency);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const { currency } = resolved;

  try {
    const presence = await getSourcePresence(currency);
    const byName = new Map(presence.map((p) => [p.source, p]));
    const venues = SOURCE_NAMES.map((name) => {
      const p = byName.get(name);
      return {
        name,
        usdNative: !isPegVenue(name),
        hasData: p != null && p.count > 0,
        oldest: p?.oldest ?? null,
        newest: p?.newest ?? null,
        count: p?.count ?? 0,
      };
    });
    return res.json({ currency, venues });
  } catch (err) {
    logError("[v1/premium] GET /premium/venues failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
