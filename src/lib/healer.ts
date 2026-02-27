import { fetchBinanceCandle, fetchBinanceRange } from "../adapters/binance";
import { fetchBybitCandle,    fetchBybitRange   } from "../adapters/bybit";
import { fetchKrakenCandle,   fetchKrakenRange  } from "../adapters/kraken";
import { fetchCoinbaseCandle, fetchCoinbaseRange } from "../adapters/coinbase";
import { fetchBitfinexCandle, fetchBitfinexRange } from "../adapters/bitfinex";
import { applyGuards, buildComposite } from "./composite";
import {
  upsertCandle, upsertSourceCandle, insertCandleIfMissing,
  countCandlesInDay, getSourceCountBaseline, getRecentCloseStddev,
  getTrailingVolumeLeader,
} from "../db/candles";
import { clearDetectedGaps } from "../db/gaps";
import { runGapScan } from "./gapDetector";
import { recordError } from "../db/errors";
import { getSetting, setSetting, getSettingInt } from "../db/appSettings";
import { query } from "../db/pool";
import { log, logError } from "./log";
import type { SourceResult } from "../types/index";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

// Minutes per tile — safe for all adapters (Coinbase hard limit: 300)
const BACKFILL_TILE = 300;

const SOURCES = ["binance", "bybit", "kraken", "coinbase", "bitfinex"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Group a sorted array of timestamps into contiguous ranges.
 * Two timestamps are considered contiguous if they are ≤ 2 minutes apart.
 */
function groupIntoRanges(timestamps: Date[]): { from: Date; to: Date }[] {
  if (!timestamps.length) return [];
  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const ranges: { from: Date; to: Date }[] = [];
  let rangeStart = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr.getTime() - prev.getTime() > 2 * 60000) {
      ranges.push({ from: rangeStart, to: new Date(prev.getTime() + 60000) });
      rangeStart = curr;
    }
    prev = curr;
  }
  ranges.push({ from: rangeStart, to: new Date(prev.getTime() + 60000) });
  return ranges;
}

// ── Core range engine ─────────────────────────────────────────────────────────

/**
 * Fetch all five sources for [from, to) in BACKFILL_TILE-minute chunks,
 * composite per-minute, and write to DB.
 *
 * Returns the Set of minute timestamps (ms) successfully written.
 *
 * overwrite=true  → upsertCandle          (gap healing, re-heal low-confidence)
 * overwrite=false → insertCandleIfMissing  (initial backfill — never clobbers live data)
 */
export async function healRange(from: Date, to: Date, overwrite: boolean): Promise<Set<number>> {
  const written      = new Set<number>();
  const baseline     = await getSourceCountBaseline();
  const sigma        = await getRecentCloseStddev();
  const volumeLeader = await getTrailingVolumeLeader(10);
  const minSources   = await getSettingInt("minSources", 3);

  // Pre-populate every expected minute slot
  const byMinute = new Map<number, SourceResult[]>();
  for (let t = from.getTime(); t < to.getTime(); t += 60000) {
    byMinute.set(t, []);
  }

  // Walk backward through [from, to) in BACKFILL_TILE chunks
  for (let tileEnd = to; tileEnd > from;) {
    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    const [bin, bby, kra, coi, bit] = await Promise.allSettled([
      fetchBinanceRange(tileEnd, limit),
      fetchBybitRange(tileEnd,   limit),
      fetchKrakenRange(tileEnd,  limit),
      fetchCoinbaseRange(tileEnd,limit),
      fetchBitfinexRange(tileEnd,limit),
    ]);

    for (const { name, res } of [
      { name: "binance",  res: bin },
      { name: "bybit",    res: bby },
      { name: "kraken",   res: kra },
      { name: "coinbase", res: coi },
      { name: "bitfinex", res: bit },
    ]) {
      if (res.status === "rejected") {
        logError(`[healer] healRange: ${name} tile failed`, res.reason);
        continue;
      }
      for (const { timestamp, candle } of res.value) {
        const tsMs = timestamp.getTime();
        if (!byMinute.has(tsMs)) continue;
        byMinute.get(tsMs)!.push({ source: name, candle });
      }
    }

    tileEnd = tileStart;
  }

  // Composite each minute and write
  for (const [tsMs, results] of byMinute) {
    if (!results.length) continue;
    const minuteTs   = new Date(tsMs);
    const allResults: SourceResult[] = SOURCES.map(
      (s) => results.find((r) => r.source === s) ?? { source: s, candle: null, error: "not_in_tile" }
    );
    const guarded = applyGuards(allResults, minSources, sigma);
    try {
      const composite = await buildComposite(guarded, baseline, volumeLeader ?? undefined);
      if (overwrite) {
        await upsertCandle({ timestamp: minuteTs, ...composite });
      } else {
        await insertCandleIfMissing({ timestamp: minuteTs, ...composite });
      }
      written.add(tsMs);
    } catch {
      // All sources rejected for this minute — leave it as a gap
    }
  }

  return written;
}

// ── Individual minute heal ────────────────────────────────────────────────────

/** Fetch one 1m candle from all five sources concurrently. Never throws. */
async function fetchAllSources(minuteTs: Date): Promise<SourceResult[]> {
  return Promise.all([
    fetchBinanceCandle(minuteTs)
      .then((candle) => ({ source: "binance",  candle } as SourceResult))
      .catch((err)  => ({ source: "binance",  candle: null, error: String(err) } as SourceResult)),
    fetchBybitCandle(minuteTs)
      .then((candle) => ({ source: "bybit",    candle } as SourceResult))
      .catch((err)  => ({ source: "bybit",    candle: null, error: String(err) } as SourceResult)),
    fetchKrakenCandle(minuteTs)
      .then((candle) => ({ source: "kraken",   candle } as SourceResult))
      .catch((err)  => ({ source: "kraken",   candle: null, error: String(err) } as SourceResult)),
    fetchCoinbaseCandle(minuteTs)
      .then((candle) => ({ source: "coinbase", candle } as SourceResult))
      .catch((err)  => ({ source: "coinbase", candle: null, error: String(err) } as SourceResult)),
    fetchBitfinexCandle(minuteTs)
      .then((candle) => ({ source: "bitfinex", candle } as SourceResult))
      .catch((err)  => ({ source: "bitfinex", candle: null, error: String(err) } as SourceResult)),
  ]);
}

/**
 * Heal a single isolated minute from all five sources.
 * Also writes per-source rows to candles_1m_sources (useful for debugging).
 * For contiguous ranges of gaps use healRange directly — it is far more efficient.
 */
export async function healMinute(minuteTs: Date): Promise<boolean> {
  try {
    const results      = await fetchAllSources(minuteTs);
    const minSources   = await getSettingInt("minSources", 3);
    const baseline     = await getSourceCountBaseline();
    const sigma        = await getRecentCloseStddev();
    const volumeLeader = await getTrailingVolumeLeader(10);
    const guarded      = applyGuards(results, minSources, sigma);

    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        timestamp: minuteTs, source: g.source,
        open: g.candle.open, high: g.candle.high, low: g.candle.low,
        close: g.candle.close, volume: g.candle.volume,
        rejected: g.rejected, rejectedReason: g.rejectedReason,
      });
    }

    const composite = await buildComposite(guarded, baseline, volumeLeader ?? undefined);
    await upsertCandle({ timestamp: minuteTs, ...composite });
    return true;
  } catch (err) {
    await recordError("healer", "healMinute", String(err));
    return false;
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

async function backfillDay(dayStart: Date): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  try {
    await healRange(dayStart, dayEnd, false);
  } catch (err) {
    logError(`[healer] backfillDay failed for ${dayStart.toISOString().slice(0, 10)}:`, err);
    await recordError("healer", "backfillDay", String(err));
  }
}

export async function runBackfill(): Promise<void> {
  const alreadyDone = await getSetting("backfillComplete");
  if (alreadyDone === "true") {
    log("[healer] backfill already complete — skipping");
    return;
  }

  log("[healer] starting backfill scan (3 months)");
  const now   = new Date();
  const start = new Date(now.getTime() - THREE_MONTHS_MS);
  start.setUTCHours(0, 0, 0, 0);

  let day = new Date(start);
  while (day < now) {
    const count = await countCandlesInDay(day);
    if (count < 1440) {
      log(`[healer] backfilling ${day.toISOString().slice(0, 10)} (${count}/1440 rows)`);
      await backfillDay(day);
    }
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }

  await setSetting("backfillComplete", "true");
  log("[healer] backfill complete — clearing stale detected gaps and rescanning");
  await clearDetectedGaps();
  await runGapScan(7);
}

// ── Re-heal low-confidence rows ───────────────────────────────────────────────

/**
 * Scan candles_1m for rows with confidence below the minimum-sources threshold,
 * group them into contiguous ranges, and re-heal each range in a single bulk
 * fetch from all five exchanges.
 *
 * A 20-minute power failure → 1 range → 5 HTTP requests total instead of 100.
 */
export async function reHealLowConfidence(windowDays = 7): Promise<void> {
  const minSources = await getSettingInt("minSources", 3);
  const baseline   = await getSourceCountBaseline();
  const threshold  = minSources / baseline; // e.g. 3/5 = 0.6

  const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const to   = new Date();
  to.setSeconds(0, 0);

  const res = await query(
    `SELECT "timestamp" FROM candles_1m
     WHERE "timestamp" >= $1 AND "timestamp" < $2 AND confidence < $3
     ORDER BY "timestamp" ASC`,
    [from, to, threshold]
  );

  if (!res.rows.length) {
    log("[healer] reHealLowConfidence: no low-confidence rows found");
    return;
  }

  const timestamps = res.rows.map((r) => new Date(r.timestamp as string));
  const ranges     = groupIntoRanges(timestamps);

  log(`[healer] reHealLowConfidence: ${res.rows.length} rows across ${ranges.length} range(s) (confidence < ${threshold.toFixed(2)}, window ${windowDays}d)`);

  let totalUpgraded = 0;
  for (const { from: rangeFrom, to: rangeTo } of ranges) {
    log(`[healer] reHealLowConfidence: healing ${rangeFrom.toISOString().slice(0, 16)} → ${rangeTo.toISOString().slice(0, 16)}`);
    const written = await healRange(rangeFrom, rangeTo, true);
    totalUpgraded += written.size;
  }

  log(`[healer] reHealLowConfidence: upgraded ${totalUpgraded}/${res.rows.length} rows`);
}
