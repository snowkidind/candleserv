import { ADAPTERS, SOURCE_NAMES } from "../adapters/registry.js";
import { symbolFor } from "../adapters/symbolMap.js";
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
// and the hourly tick from running runBackfill() concurrently.
let backfillRunning = false;
export function isBackfillRunning(): boolean { return backfillRunning; }


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
  const baseline     = await getSourceCountBaseline("BTC");
  const sigma        = await getRecentCloseStddev("BTC");
  const volumeLeader = await getTrailingVolumeLeader("BTC", 10);
  const minSources   = await getSettingInt("minSources", 3);

  // Pre-populate every expected minute slot
  const byMinute = new Map<number, SourceResult[]>();
  for (let t = from.getTime(); t < to.getTime(); t += 60000) {
    byMinute.set(t, []);
  }

  // Adapter-declared out-of-history (e.g. gate caps at ~6.9 days) is expected
  // when a re-heal window reaches deeper than a venue allows, not a fault.
  // Aggregate quietly and emit one summary line per source at the end.
  const outOfHistoryEarliest: Record<string, Date> = {};

  // Walk backward through [from, to) in BACKFILL_TILE chunks
  let firstTile = true;
  for (let tileEnd = to; tileEnd > from;) {
    // Throttle before every tile except the first to respect Kraken's ~1 req/sec rate limit
    //if (!firstTile) for some reason this doesnt work.
    await new Promise(r => setTimeout(r, 5000));
    firstTile = false;
    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    const excluded = new Set(getCurrentFormula().excludedSources);
    const activeAdapters = ADAPTERS.filter((a) => !excluded.has(a.name));

    const settled = await Promise.allSettled(
      activeAdapters.map((a) => a.fetchRange(symbolFor("BTC", a.name), tileEnd, limit)),
    );

    for (let i = 0; i < activeAdapters.length; i++) {
      const name = activeAdapters[i].name;
      const res = settled[i];
      if (res.status === "rejected") {
        if (isOutOfHistory(res.reason)) {
          const prev = outOfHistoryEarliest[name];
          if (!prev || tileStart < prev) outOfHistoryEarliest[name] = tileStart;
          continue;
        }
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

  // One tidy summary line per source for venues that ran out of history.
  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[healer] healRange: ${source} has no data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  // overwrite=true path: re-heal low confidence + manual gap heal. Uses
  // composeMinute so the canonical bulk UPDATE on usedInFormula runs and the
  // composite + archive flags commit in one transaction.
  //
  // overwrite=false path: initial backfill — preserves "never clobber live
  // data" via insertCandleIfMissing. composeMinute always overwrites, so the
  // backfill path keeps using the legacy buildComposite flow. The Phase 3
  // deferred bug (stale-NULL usedInFormula on already-composed minutes) can
  // be cleaned up by a one-shot recomposeRange after this phase ships.
  for (const [tsMs, results] of byMinute) {
    if (!results.length) continue;
    const minuteTs   = new Date(tsMs);
    const allResults: SourceResult[] = SOURCE_NAMES.map(
      (s) => results.find((r) => r.source === s) ?? { source: s, candle: null, error: "not_in_tile" }
    );
    const guarded = applyGuards(allResults, minSources, sigma);

    // Write archive rows first. usedInFormula left NULL — composeMinute will
    // set it via the bulk UPDATE. For the backfill path we still want the
    // archive populated.
    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        currency: "BTC", timestamp: minuteTs, source: g.source,
        open: g.candle.open, high: g.candle.high, low: g.candle.low,
        close: g.candle.close, volume: g.candle.volume,
        rejected: g.rejected, rejectedReason: g.rejectedReason,
        usedInFormula: null,
      });
    }

    if (overwrite) {
      const result = await composeMinute(
        "BTC",
        minuteTs,
        getCurrentFormula(),
        { baseline, minSources, volumeLeader: volumeLeader ?? undefined },
      );
      if (result.composed) written.add(tsMs);
    } else {
      // Initial backfill — never clobber live data. Compute composite from
      // freshly-fetched guarded set; only insert if no row exists. Per-source
      // rows already written above; usedInFormula stays NULL on the new ones
      // and unchanged on any pre-existing ones (a future recomposeRange will
      // reconcile).
      try {
        // Initial-backfill path: no peg rates available yet (Phase 5 will
        // backfill stable_rates_1m_sources). Pass undefined so the composite
        // is raw-quote — these rows are later replaced by recomposeRange.
        const composite = await buildComposite(guarded, baseline, minuteTs);
        await insertCandleIfMissing({ currency: "BTC", timestamp: minuteTs, ...composite });
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
 * Fetch one 1m candle from every formula-included adapter concurrently. Never
 * throws. Excluded sources don't get fetched — gap-filling for them goes
 * through ensureSourceCoverage (Phase 5), not the heal path.
 */
async function fetchAllSources(minuteTs: Date): Promise<SourceResult[]> {
  const excluded = new Set(getCurrentFormula().excludedSources);
  return Promise.all(
    ADAPTERS.filter((a) => !excluded.has(a.name)).map((a) =>
      a.fetchOne(symbolFor("BTC", a.name), minuteTs)
        .then((candle) => ({ source: a.name, candle } as SourceResult))
        .catch((err) => ({ source: a.name, candle: null, error: String(err) } as SourceResult)),
    ),
  );
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
    const baseline     = await getSourceCountBaseline("BTC");
    const sigma        = await getRecentCloseStddev("BTC");
    const volumeLeader = await getTrailingVolumeLeader("BTC", 10);
    const guarded      = applyGuards(results, minSources, sigma);

    // Step 1: write fetched archive rows with their applyGuards verdict.
    // usedInFormula stays NULL; composeMinute sets it via bulk UPDATE.
    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        currency: "BTC", timestamp: minuteTs, source: g.source,
        open: g.candle.open, high: g.candle.high, low: g.candle.low,
        close: g.candle.close, volume: g.candle.volume,
        rejected: g.rejected, rejectedReason: g.rejectedReason,
        usedInFormula: null,
      });
    }

    // Step 2: composeMinute reads back, builds composite, writes both in tx.
    const result = await composeMinute(
      "BTC",
      minuteTs,
      getCurrentFormula(),
      { baseline, minSources, volumeLeader: volumeLeader ?? undefined },
    );
    if (!result.composed) {
      await recordError("healer", "healMinute:noComposite",
        `composeMinute skipped ${minuteTs.toISOString()} — ${result.contributing} sources after formula+guards`);
      return false;
    }
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
  if (backfillRunning) {
    log("[healer] backfill already in progress — skipping");
    return;
  }
  const alreadyDone = await getSetting("backfillComplete");
  if (alreadyDone === "true") {
    log("[healer] backfill already complete — skipping");
    return;
  }

  backfillRunning = true;
  beginActivity("runBackfill", { windowDays: 90 });
  try {
    log("[healer] starting backfill scan (3 months)");
    const now   = new Date();
    const start = new Date(now.getTime() - THREE_MONTHS_MS);
    start.setUTCHours(0, 0, 0, 0);

    let day = new Date(start);
    while (day < now) {
      const count = await countCandlesInDay("BTC", day);
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
  } finally {
    backfillRunning = false;
    endActivity("runBackfill");
  }
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
  beginActivity("reHealLowConfidence", { windowDays });
  try {
    const minSources = await getSettingInt("minSources", 3);
    const baseline   = await getSourceCountBaseline("BTC");
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
  } finally {
    endActivity("reHealLowConfidence");
  }
}
