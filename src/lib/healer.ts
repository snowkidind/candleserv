import { ADAPTER_BY_NAME } from "../adapters/registry.js";
import { recordApiRequest, PEG_CURRENCY } from "./apiCounter.js";
import { upsertStableRate } from "../db/stableRates.js";
import { getActiveFeeds } from "../db/currencyFeeds.js";
import { getInceptionTs } from "../db/currencies.js";
import { applyGuards, buildComposite } from "./composite.js";
import { composeMinute } from "./compose.js";
import { getCurrentFormula } from "../db/formulaChanges.js";
import {
  upsertSourceCandle, insertCandleIfMissing,
  countCandlesInDay, getSourceCountBaseline, getRecentCloseStddev,
  getTrailingVolumeLeader,
} from "../db/candles.js";
import { clearDetectedGaps } from "../db/gaps.js";
import { runGapScan } from "./gapDetector.js";
import { recordError } from "../db/errors.js";
import { isOutOfHistory } from "../adapters/errors.js";
import { getSetting, setSetting, getSettingInt } from "../db/appSettings.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";
import { beginActivity, endActivity } from "./healerStatus.js";
import type { SourceResult } from "../types/index.js";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

// Minutes per tile — safe for all adapters (Coinbase hard limit: 300)
const BACKFILL_TILE = 300;

// Single-flight guard: prevents the boot kick, the gap-detector trigger,
// and the hourly tick from running runBackfill() concurrently. Deliberately
// currency-agnostic — only one currency backfills at a time (serialized →
// kinder to exchange rate limits). The completion latch is per-currency.
let backfillRunning = false;
export function isBackfillRunning(): boolean { return backfillRunning; }

// B3 temporal floor: the earliest minute a currency should ever be scanned or
// backfilled from. A not-yet-probed currency has inceptionTs = NULL — it MUST
// coalesce to now − 90d, never epoch (finding B-null). Resolve the NULL with
// ?? before any Date math; never `new Date(nullableInceptionTs)`.
async function backfillFloor(currency: string): Promise<Date> {
  const inception = await getInceptionTs(currency);
  return inception ?? new Date(Date.now() - THREE_MONTHS_MS);
}


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
 * Fetch a currency's active feeds for [from, to) in BACKFILL_TILE-minute chunks,
 * composite per-minute, and write to DB.
 *
 * Returns the Set of minute timestamps (ms) successfully written.
 *
 * overwrite=true  → composeMinute          (gap healing, re-heal low-confidence)
 * overwrite=false → insertCandleIfMissing  (initial backfill — never clobbers live data)
 */
export async function healRange(currency: string, from: Date, to: Date, overwrite: boolean): Promise<Set<number>> {
  const written      = new Set<number>();

  // No-future guard (candlestick time): never request minutes that haven't
  // closed. Clamp the exclusive upper bound to the start of the current minute,
  // so the range covers at most the latest CLOSED minute; the live collector and
  // gap detector own anything newer. Without this, backfilling the current day
  // tiles a dayEnd of next-midnight into the future and venues reject it
  // (coinbase/gate HTTP 400 "invalid time range").
  const latestClosedExclusive = Math.floor(Date.now() / 60000) * 60000;
  if (to.getTime() > latestClosedExclusive) {
    const clamped = new Date(latestClosedExclusive);
    log(`[healer] healRange: clamping ${currency} end ${to.toISOString()} → ${clamped.toISOString()} (no future requests)`);
    to = clamped;
  }
  if (to.getTime() <= from.getTime()) {
    log(`[healer] healRange: ${currency} window empty after no-future clamp — nothing to heal`);
    return written;
  }

  const baseline     = await getSourceCountBaseline(currency);
  const sigma        = await getRecentCloseStddev(currency);
  const volumeLeader = await getTrailingVolumeLeader(currency, 10);
  const minSources   = await getSettingInt("minSources", 3);

  // Effective fetch set for this currency: probed-available AND enabled feeds,
  // minus the global formula kill-switch.
  const excluded = new Set(getCurrentFormula().excludedSources);
  const feeds = (await getActiveFeeds(currency)).filter((f) => !excluded.has(f.source));
  if (!feeds.length) {
    log(`[healer] healRange: no active feeds for ${currency} — nothing to heal`);
    return written;
  }
  const feedSources = feeds.map((f) => f.source);

  // Heal (overwrite) must ALSO restore each USDT venue's peg rate for the range,
  // or composeMinute drops every USDT venue as missing_paired_rate and the minute
  // stays an unresolvable gap. The backfill path (overwrite=false) deliberately
  // stays raw — stableRateBackfill + a later recomposeRange reconcile it — so the
  // peg wave only runs when overwrite=true.
  const fetchPegs = overwrite;
  const usdtFeeds = fetchPegs
    ? feeds.filter((f) => ADAPTER_BY_NAME[f.source].normalize.pegFetcherRange)
    : [];
  const pegByMinute = new Map<number, Map<string, number>>();

  // Pre-populate every expected minute slot
  const byMinute = new Map<number, SourceResult[]>();
  for (let t = from.getTime(); t < to.getTime(); t += 60000) {
    byMinute.set(t, []);
  }

  // Adapter-declared out-of-history (e.g. gate caps at ~6.9 days) is expected
  // when a re-heal window reaches deeper than a venue allows, not a fault.
  // Aggregate quietly and emit one summary line per source at the end.
  const outOfHistoryEarliest: Record<string, Date> = {};

  // Walk backward through [from, to) in BACKFILL_TILE chunks. Throttle before
  // every tile (~5s) to respect the slowest venue's rate limit.
  for (let tileEnd = to; tileEnd > from;) {
    await new Promise(r => setTimeout(r, 5000));
    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    // Adapters disagree on endTime inclusivity: binance/bybit/bitget INCLUDE the
    // endTime minute and so drop the bottom of a [tileStart, tileEnd) window,
    // while gate/bitfinex/coinbase include the bottom. Fetch one extra minute
    // (limit+1) so every adapter returns a superset of the tile, then filter each
    // row to the half-open tile window below — every minute lands in exactly one
    // tile regardless of venue. (Without this the very first minute of a backfilled
    // day — 00:00 — never lands, leaving a recurring single-minute gap.)
    const settled = await Promise.allSettled(
      feeds.map((f) => {
        recordApiRequest(currency, f.source, "backfill");
        return ADAPTER_BY_NAME[f.source].fetchRange(f.symbol, tileEnd, limit + 1);
      }),
    );

    for (let i = 0; i < feeds.length; i++) {
      const name = feeds[i].source;
      const res = settled[i];
      if (res.status === "rejected") {
        if (isOutOfHistory(res.reason)) {
          const prev = outOfHistoryEarliest[name];
          if (!prev || tileStart < prev) outOfHistoryEarliest[name] = tileStart;
          continue;
        }
        logError(`[healer] healRange: ${currency}/${name} tile failed`, res.reason);
        continue;
      }
      for (const { timestamp, candle } of res.value) {
        const tsMs = timestamp.getTime();
        if (tsMs < tileStartMs || tsMs >= tileEnd.getTime()) continue; // half-open tile window
        if (!byMinute.has(tsMs)) continue;
        byMinute.get(tsMs)!.push({ source: name, candle });
      }
    }

    // Peg wave for this tile (heal only) — same chunking/throttle as the candle
    // fetch above, per-USDT-venue pegFetcherRange, accumulated per-minute. Adapter
    // out-of-history is expected at depth and aggregated into the same summary.
    if (usdtFeeds.length) {
      const pegSettled = await Promise.allSettled(
        usdtFeeds.map((f) => {
          recordApiRequest(PEG_CURRENCY, f.source, "backfill");
          return ADAPTER_BY_NAME[f.source].normalize.pegFetcherRange!(tileEnd, limit + 1);
        }),
      );
      for (let i = 0; i < usdtFeeds.length; i++) {
        const name = usdtFeeds[i].source;
        const res = pegSettled[i];
        if (res.status === "rejected") {
          if (isOutOfHistory(res.reason)) {
            const prev = outOfHistoryEarliest[name];
            if (!prev || tileStart < prev) outOfHistoryEarliest[name] = tileStart;
          } else {
            logError(`[healer] healRange: ${currency}/${name} peg tile failed`, res.reason);
          }
          continue;
        }
        for (const { timestamp, rate } of res.value) {
          const tsMs = timestamp.getTime();
          if (tsMs < tileStartMs || tsMs >= tileEnd.getTime()) continue; // half-open tile window
          if (!byMinute.has(tsMs)) continue;
          let m = pegByMinute.get(tsMs);
          if (!m) { m = new Map(); pegByMinute.set(tsMs, m); }
          m.set(name, rate);
        }
      }
    }

    tileEnd = tileStart;
  }

  // One tidy summary line per source for venues that ran out of history.
  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[healer] healRange: ${currency}/${source} has no data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  // overwrite=true path: re-heal low confidence + manual gap heal. Uses
  // composeMinute so the canonical bulk UPDATE on usedInFormula runs and the
  // composite + archive flags commit in one transaction.
  //
  // overwrite=false path: initial backfill — preserves "never clobber live
  // data" via insertCandleIfMissing. composeMinute always overwrites, so the
  // backfill path keeps using the legacy buildComposite flow (raw-quote, no peg
  // rates yet — stableRateBackfill + a later recomposeRange reconcile).
  for (const [tsMs, results] of byMinute) {
    if (!results.length) continue;
    const minuteTs   = new Date(tsMs);
    const allResults: SourceResult[] = feedSources.map(
      (s) => results.find((r) => r.source === s) ?? { source: s, candle: null, error: "not_in_tile" }
    );
    const minutePegs = fetchPegs ? (pegByMinute.get(tsMs) ?? new Map<string, number>()) : undefined;
    const guarded = applyGuards(allResults, minSources, sigma, minutePegs);

    // Write archive rows first. usedInFormula left NULL — composeMinute will
    // set it via the bulk UPDATE.
    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        currency, timestamp: minuteTs, source: g.source,
        open: g.candle.open, high: g.candle.high, low: g.candle.low,
        close: g.candle.close, volume: g.candle.volume,
        rejected: g.rejected, rejectedReason: g.rejectedReason,
        usedInFormula: null,
      });
    }

    // Restore paired peg rates BEFORE composeMinute reads them back — without
    // these, every USDT venue is dropped as missing_paired_rate and the minute
    // can never heal. Only for venues that returned a candle this minute (archive
    // row written just above), keeping the rate↔candle bundle coherent.
    if (overwrite && minutePegs) {
      for (const [source, rate] of minutePegs) {
        if (!guarded.some((g) => g.source === source && g.candle)) continue;
        await upsertStableRate({
          timestamp: minuteTs, source, rate,
          pegSourcePair: ADAPTER_BY_NAME[source].normalize.pegSourcePair!,
        });
      }
    }

    if (overwrite) {
      const result = await composeMinute(
        currency,
        minuteTs,
        getCurrentFormula(),
        { baseline, minSources, volumeLeader: volumeLeader ?? undefined },
      );
      if (result.composed) written.add(tsMs);
    } else {
      // Initial backfill — never clobber live data. Compute composite from
      // freshly-fetched guarded set; only insert if no row exists.
      try {
        const composite = await buildComposite(guarded, baseline, minuteTs, undefined, true, currency);
        await insertCandleIfMissing({ currency, timestamp: minuteTs, ...composite });
        written.add(tsMs);
      } catch {
        // All-rejected: leave the minute as a gap.
      }
    }
  }

  return written;
}

// ── Individual minute heal ────────────────────────────────────────────────────

/**
 * Fetch one 1m candle from every active feed for a currency concurrently. Never
 * throws. Excluded/unavailable sources aren't fetched — gap-filling for them
 * goes through ensureSourceCoverage (repair), not the heal path.
 */
async function fetchAllSources(currency: string, minuteTs: Date): Promise<SourceResult[]> {
  const excluded = new Set(getCurrentFormula().excludedSources);
  const feeds = (await getActiveFeeds(currency)).filter((f) => !excluded.has(f.source));
  return Promise.all(
    feeds.map((f) => {
      recordApiRequest(currency, f.source, "heal1m");
      return ADAPTER_BY_NAME[f.source].fetchOne(f.symbol, minuteTs)
        .then((candle) => ({ source: f.source, candle } as SourceResult))
        .catch((err) => ({ source: f.source, candle: null, error: String(err) } as SourceResult));
    }),
  );
}

/**
 * Heal a single isolated minute for a currency from all its active feeds.
 * Also writes per-source rows to candles_1m_sources (useful for debugging).
 * For contiguous ranges of gaps use healRange directly — it is far more efficient.
 */
export async function healMinute(currency: string, minuteTs: Date): Promise<boolean> {
  try {
    const results      = await fetchAllSources(currency, minuteTs);
    const minSources   = await getSettingInt("minSources", 3);
    const baseline     = await getSourceCountBaseline(currency);
    const sigma        = await getRecentCloseStddev(currency);
    const volumeLeader = await getTrailingVolumeLeader(currency, 10);

    // Peg wave: fetch each USDT venue's rate for this minute, so the outlier
    // guard compares in USD space and (below) the paired rate rows exist for
    // composeMinute. USD-native venues have no pegFetcher and stay identity.
    const usdtResults = results.filter((r) => r.candle && ADAPTER_BY_NAME[r.source]?.normalize.pegFetcher);
    const pegSettled = await Promise.allSettled(
      usdtResults.map((r) => {
        recordApiRequest(PEG_CURRENCY, r.source, "heal1m");
        return ADAPTER_BY_NAME[r.source].normalize.pegFetcher!(minuteTs);
      }),
    );
    const minutePegs = new Map<string, number>();
    for (let i = 0; i < usdtResults.length; i++) {
      const res = pegSettled[i];
      if (res.status === "fulfilled" && res.value != null) minutePegs.set(usdtResults[i].source, res.value);
    }

    const guarded = applyGuards(results, minSources, sigma, minutePegs);

    // Step 1: write fetched archive rows with their applyGuards verdict.
    // usedInFormula stays NULL; composeMinute sets it via bulk UPDATE.
    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        currency, timestamp: minuteTs, source: g.source,
        open: g.candle.open, high: g.candle.high, low: g.candle.low,
        close: g.candle.close, volume: g.candle.volume,
        rejected: g.rejected, rejectedReason: g.rejectedReason,
        usedInFormula: null,
      });
    }

    // Step 1b: write paired peg rates BEFORE composeMinute reads them, or every
    // USDT venue is dropped as missing_paired_rate and the minute can't heal.
    for (const [source, rate] of minutePegs) {
      if (!guarded.some((g) => g.source === source && g.candle)) continue;
      await upsertStableRate({
        timestamp: minuteTs, source, rate,
        pegSourcePair: ADAPTER_BY_NAME[source].normalize.pegSourcePair!,
      });
    }

    // Step 2: composeMinute reads back, builds composite, writes both in tx.
    const result = await composeMinute(
      currency,
      minuteTs,
      getCurrentFormula(),
      { baseline, minSources, volumeLeader: volumeLeader ?? undefined },
    );
    if (!result.composed) {
      await recordError("healer", "healMinute:noComposite",
        `composeMinute skipped ${currency} ${minuteTs.toISOString()} — ${result.contributing} sources after formula+guards`);
      return false;
    }
    return true;
  } catch (err) {
    await recordError("healer", "healMinute", String(err));
    return false;
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

async function backfillDay(currency: string, dayStart: Date): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  try {
    await healRange(currency, dayStart, dayEnd, false);
  } catch (err) {
    logError(`[healer] backfillDay failed for ${currency} ${dayStart.toISOString().slice(0, 10)}:`, err);
    await recordError("healer", "backfillDay", String(err));
  }
}

/**
 * Backfill a currency's initial history (B1). Per-currency completion latch
 * (backfillComplete:<code>). Window floored at the currency's inception (B3) so
 * a recently-listed token backfills only from inception, not 90 d of empty
 * minutes — and a not-yet-probed currency floors at now − 90d, never epoch.
 * Serialized by the global in-flight guard.
 */
export async function runBackfill(currency: string): Promise<void> {
  if (backfillRunning) {
    log(`[healer] backfill already in progress — skipping ${currency}`);
    return;
  }
  const latchKey = `backfillComplete:${currency}`;
  const alreadyDone = await getSetting(latchKey);
  if (alreadyDone === "true") {
    log(`[healer] backfill already complete for ${currency} — skipping`);
    return;
  }

  backfillRunning = true;
  beginActivity("runBackfill", { currency, windowDays: 90 });
  try {
    log(`[healer] starting backfill scan for ${currency} (3 months, floored at inception)`);
    const now   = new Date();
    const floor = await backfillFloor(currency);   // inception ?? now − 90d
    const start = new Date(Math.max(now.getTime() - THREE_MONTHS_MS, floor.getTime()));
    start.setUTCHours(0, 0, 0, 0);

    let day = new Date(start);
    while (day < now) {
      const count = await countCandlesInDay(currency, day);
      if (count < 1440) {
        log(`[healer] backfilling ${currency} ${day.toISOString().slice(0, 10)} (${count}/1440 rows)`);
        await backfillDay(currency, day);
      }
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    }

    await setSetting(latchKey, "true");
    log(`[healer] backfill complete for ${currency} — clearing stale detected gaps and rescanning`);
    await clearDetectedGaps(currency);
    await runGapScan(7, currency);
  } finally {
    backfillRunning = false;
    endActivity("runBackfill");
  }
}

/**
 * Currency onboarding (B1) — the single canonical path for a newly-enabled
 * currency to get its initial history. Clears the per-currency latch and kicks
 * runBackfill fire-and-forget behind the global in-flight guard. Returns whether
 * the backfill STARTED now or was DEFERRED (guard busy with another currency)
 * so the caller can surface the state (no toggle-lock). A deferred kick is
 * recovered by the hourly per-currency gap scan once the guard frees.
 */
export async function onboardCurrency(currency: string): Promise<"started" | "deferred"> {
  await setSetting(`backfillComplete:${currency}`, "false");
  if (backfillRunning) {
    log(`[healer] onboardCurrency: ${currency} deferred — a backfill is already running`);
    return "deferred";
  }
  runBackfill(currency).catch((err) => logError(`[healer] onboardCurrency: backfill failed for ${currency}:`, err));
  return "started";
}

// ── Re-heal low-confidence rows ───────────────────────────────────────────────

/**
 * Scan a currency's candles_1m for rows with confidence below the
 * minimum-sources threshold, group them into contiguous ranges, and re-heal
 * each range in a single bulk fetch from all its active feeds.
 *
 * A 20-minute power failure → 1 range → 1 range request instead of 20.
 */
export async function reHealLowConfidence(currency: string, windowDays = 7): Promise<void> {
  beginActivity("reHealLowConfidence", { currency, windowDays });
  try {
    const minSources = await getSettingInt("minSources", 3);
    const baseline   = await getSourceCountBaseline(currency);
    const threshold  = minSources / baseline; // e.g. 3/5 = 0.6

    const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const to   = new Date();
    to.setSeconds(0, 0);

    const res = await query(
      `SELECT "timestamp" FROM candles_1m
       WHERE "currency" = $1 AND "timestamp" >= $2 AND "timestamp" < $3 AND confidence < $4
       ORDER BY "timestamp" ASC`,
      [currency, from, to, threshold]
    );

    if (!res.rows.length) {
      log(`[healer] reHealLowConfidence: no low-confidence rows found for ${currency}`);
      return;
    }

    const timestamps = res.rows.map((r) => new Date(r.timestamp as string));
    const ranges     = groupIntoRanges(timestamps);

    log(`[healer] reHealLowConfidence: ${res.rows.length} ${currency} rows across ${ranges.length} range(s) (confidence < ${threshold.toFixed(2)}, window ${windowDays}d)`);

    let totalUpgraded = 0;
    for (const { from: rangeFrom, to: rangeTo } of ranges) {
      log(`[healer] reHealLowConfidence: healing ${currency} ${rangeFrom.toISOString().slice(0, 16)} → ${rangeTo.toISOString().slice(0, 16)}`);
      const written = await healRange(currency, rangeFrom, rangeTo, true);
      totalUpgraded += written.size;
    }

    log(`[healer] reHealLowConfidence: upgraded ${totalUpgraded}/${res.rows.length} ${currency} rows`);
  } finally {
    endActivity("reHealLowConfidence");
  }
}
