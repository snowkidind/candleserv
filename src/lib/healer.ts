import { fetchBinanceRange } from "../adapters/binance";
import { upsertCandle, insertCandleIfMissing, countCandlesInDay } from "../db/candles";
import { clearDetectedGaps } from "../db/gaps";
import { runGapScan } from "./gapDetector";
import { recordError } from "../db/errors";
import { getSetting, setSetting } from "../db/appSettings";
import { log, logError } from "./log";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Heal a single missing minute timestamp by fetching from all sources.
 * Returns true if the slot was filled.
 */
export async function healMinute(minuteTs: Date): Promise<boolean> {
  try {
    const rows = await fetchBinanceRange(new Date(minuteTs.getTime() + 60000), 2);
    const match = rows.find((r) => r.timestamp.getTime() === minuteTs.getTime());
    if (!match) return false;

    await upsertCandle({
      timestamp: minuteTs,
      open: match.candle.open,
      high: match.candle.high,
      low: match.candle.low,
      close: match.candle.close,
      volume: match.candle.volume,
      volumeNormalized: match.candle.volume, // single source — no normalization
      sourceCount: 1,
      sourceCountBaseline: 5,
      sources: 1, // binance bit
      confidence: 0.2,
    });
    return true;
  } catch (err) {
    await recordError("healer", "healMinute", String(err));
    return false;
  }
}

/**
 * Backfill a full day from Binance.
 * Fetches 1000 + remaining candles, upserts any that are missing.
 * Idempotent — existing rows are left untouched.
 */
async function backfillDay(dayStart: Date): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  try {
    // Two fetches tiling the day: first 1000 minutes, then remaining 440
    const first1000End = new Date(dayStart.getTime() + 1000 * 60 * 1000);
    const [first, second] = await Promise.all([
      fetchBinanceRange(first1000End, 1000),
      fetchBinanceRange(dayEnd, 440),
    ]);

    for (const { timestamp, candle } of [...first, ...second]) {
      if (timestamp < dayStart || timestamp >= dayEnd) continue;
      await insertCandleIfMissing({
        timestamp,
        ...candle,
        volumeNormalized: candle.volume,
        sourceCount: 1,
        sourceCountBaseline: 5,
        sources: 1,
        confidence: 0.2,
      });
    }
  } catch (err) {
    logError(`[healer] backfillDay failed for ${dayStart.toISOString()}:`, err);
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
  const now = new Date();
  const start = new Date(now.getTime() - THREE_MONTHS_MS);

  // Align to UTC day start
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
