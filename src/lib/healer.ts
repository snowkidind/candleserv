import { fetchBinanceCandle, fetchBinanceRange } from "../adapters/binance";
import { fetchBybitCandle,   fetchBybitRange   } from "../adapters/bybit";
import { fetchKrakenCandle,  fetchKrakenRange  } from "../adapters/kraken";
import { fetchCoinbaseCandle,fetchCoinbaseRange} from "../adapters/coinbase";
import { fetchBitfinexCandle,fetchBitfinexRange} from "../adapters/bitfinex";
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

// Minutes per backfill tile — safe for all adapters (Coinbase limit: 300)
const BACKFILL_TILE = 300;

const SOURCES = ["binance", "bybit", "kraken", "coinbase", "bitfinex"] as const;

/**
 * Fetch one 1m candle from all five sources concurrently.
 * Never throws — failed sources return candle: null.
 */
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
 * Heal a single missing (or low-confidence) minute by fetching from all sources
 * and building a proper composite. Returns true if the slot was written.
 */
export async function healMinute(minuteTs: Date): Promise<boolean> {
  try {
    const results     = await fetchAllSources(minuteTs);
    const minSources  = await getSettingInt("minSources", 3);
    const baseline    = await getSourceCountBaseline();
    const sigma       = await getRecentCloseStddev();
    const volumeLeader = await getTrailingVolumeLeader(10);
    const guarded     = applyGuards(results, minSources, sigma);

    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        timestamp:      minuteTs,
        source:         g.source,
        open:           g.candle.open,
        high:           g.candle.high,
        low:            g.candle.low,
        close:          g.candle.close,
        volume:         g.candle.volume,
        rejected:       g.rejected,
        rejectedReason: g.rejectedReason,
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

/**
 * Backfill a full day using all five sources.
 * Tiles the day in BACKFILL_TILE-minute chunks, fetches all sources in parallel
 * per tile, then builds a per-minute composite and inserts any missing slots.
 * Idempotent — existing rows with sufficient confidence are left untouched.
 */
async function backfillDay(dayStart: Date): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  try {
    const baseline     = await getSourceCountBaseline();
    const sigma        = await getRecentCloseStddev();
    const volumeLeader = await getTrailingVolumeLeader(10);
    const minSources   = await getSettingInt("minSources", 3);

    // minute-slot → per-source results collected across all tiles
    const byMinute = new Map<number, SourceResult[]>();
    for (let t = dayStart.getTime(); t < dayEnd.getTime(); t += 60000) {
      byMinute.set(t, []);
    }

    // Walk backward through the day in BACKFILL_TILE-minute tiles
    for (let tileEnd = dayEnd; tileEnd > dayStart;) {
      const tileStartMs = Math.max(dayStart.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
      const tileStart   = new Date(tileStartMs);
      const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

      const [bin, bby, kra, coi, bit] = await Promise.allSettled([
        fetchBinanceRange(tileEnd, limit),
        fetchBybitRange(tileEnd,   limit),
        fetchKrakenRange(tileEnd,  limit),
        fetchCoinbaseRange(tileEnd,limit),
        fetchBitfinexRange(tileEnd,limit),
      ]);

      const settled = [
        { name: "binance",  res: bin },
        { name: "bybit",    res: bby },
        { name: "kraken",   res: kra },
        { name: "coinbase", res: coi },
        { name: "bitfinex", res: bit },
      ];

      for (const { name, res } of settled) {
        if (res.status === "rejected") {
          logError(`[healer] backfillDay: ${name} tile failed`, res.reason);
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

    // Composite each minute slot and insert if missing
    for (const [tsMs, results] of byMinute) {
      if (!results.length) continue;

      const minuteTs = new Date(tsMs);

      // Fill absent sources as null so applyGuards sees the full picture
      const allResults: SourceResult[] = SOURCES.map(
        (s) => results.find((r) => r.source === s) ?? { source: s, candle: null, error: "not_in_tile" }
      );

      const guarded = applyGuards(allResults, minSources, sigma);
      try {
        const composite = await buildComposite(guarded, baseline, volumeLeader ?? undefined);
        await insertCandleIfMissing({ timestamp: minuteTs, ...composite });
      } catch {
        // All sources rejected for this minute — leave gap for the healer
      }
    }
  } catch (err) {
    logError(`[healer] backfillDay failed for ${dayStart.toISOString().slice(0, 10)}:`, err);
    await recordError("healer", "backfillDay", String(err));
  }
}

/**
 * Run initial backfill: scan the last 3 months day by day.
 * Skip days that already have 1440 rows.
 */
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

/**
 * Scan candles_1m for rows with confidence below the minimum-sources threshold
 * and re-heal them using all five sources.
 *
 * Catches rows written during power-failure recovery that only had a single
 * source (confidence ≈ 0.2). Runs on startup after the gap scan so that any
 * outage-healed rows are upgraded to full composite quality.
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

  log(`[healer] reHealLowConfidence: upgrading ${res.rows.length} rows (confidence < ${threshold.toFixed(2)}, window ${windowDays}d)`);

  let upgraded = 0;
  for (const row of res.rows) {
    const ok = await healMinute(new Date(row.timestamp as string));
    if (ok) upgraded++;
  }

  log(`[healer] reHealLowConfidence: upgraded ${upgraded}/${res.rows.length} rows`);
}
