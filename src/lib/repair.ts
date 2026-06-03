/**
 * Repair operations — Phase 5 of the exchange-expansion plan.
 *
 *   ensureSourceCoverage   — fills missing per-source archive rows for a window.
 *                            Empty fetches get a "no_data" sentinel row so we
 *                            don't refetch on every call.
 *   recomposeRange         — re-derives candles_1m from the archive over a
 *                            window, applying the supplied formula (or the
 *                            live one).
 *   repairRange            — convenience: ensureSourceCoverage then
 *                            recomposeRange in sequence.
 *
 * All three are hard-bounded by the repair horizon (operator-configurable via
 * the `repairHorizonDays` app_setting; defaults to 180d — see retention.ts).
 * Window-end clamps are the caller's responsibility (the REST handler enforces
 * them).
 */
import { ADAPTER_BY_NAME } from "../adapters/registry.js";
import { recordApiRequest } from "./apiCounter.js";
import { getFeedMap } from "../db/currencyFeeds.js";
import { getCurrency } from "../db/currencies.js";
import { reconcileHealedGaps } from "../db/gaps.js";
import { isOutOfHistory } from "../adapters/errors.js";
import { composeMinute } from "./compose.js";
import type { Formula } from "./compose.js";
import {
  getSourceCountBaseline,
  getTrailingVolumeLeader,
} from "../db/candles.js";
import {
  ensureSeededTimeline, resolveFormulaAt, resolveRepairSources, toExcludedSources,
  type FormulaVersion,
} from "../db/formulaVersions.js";
import { getSettingInt } from "../db/appSettings.js";
import { getRepairHorizonMs } from "./retention.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";

// Tile size for ensureSourceCoverage fetchRange calls. 300 is the Coinbase
// hard limit; smaller tiles mean more HTTP requests but more progress
// granularity. Matches the BACKFILL_TILE in healer.ts.
const ENSURE_TILE = 300;

// Throttle between tiles to keep us under exchange rate limits — same value
// healRange uses.
const TILE_THROTTLE_MS = 5000;

export interface EnsureSourceCoverageResult {
  rowsFetched: number;
  sentinelsWritten: number;
  skipped: number;
  tilesSkipped: number;       // tiles already fully covered for every fetch source → no fetch/throttle
  failedPerSource: Record<string, number>;
  clamped?: { from?: string; to?: string }; // ISO timestamps after clamping
}

export interface EnsureSourceCoverageOpts {
  sources?: string[];     // default: all formula-included adapters
  retryEmpty?: boolean;   // default: false; if true, delete 'no_data' sentinels in the window first
  signal?: AbortSignal;   // honored at tile boundaries for cancellation
}

/**
 * Fill missing per-source archive rows in [from, to). For every (minute,
 * source) pair without an archive row, fetch the adapter for that minute.
 * On success, insert the row with usedInFormula=NULL (recomposeRange sets
 * it later). On empty/throw, insert a sentinel row (rejected=true,
 * rejectedReason='no_data') so subsequent calls skip it.
 *
 * Hard-clamped to the repair horizon (repairHorizonDays app_setting, default
 * 180d). Existing rows are never overwritten (ON CONFLICT DO NOTHING).
 */
export async function ensureSourceCoverage(
  currency: string,
  from: Date,
  to: Date,
  opts?: EnsureSourceCoverageOpts,
): Promise<EnsureSourceCoverageResult> {
  // Clamp to retention horizon.
  const retentionHorizon = new Date(Date.now() - await getRepairHorizonMs());
  const clamped: EnsureSourceCoverageResult["clamped"] = {};
  if (from < retentionHorizon) {
    clamped.from = retentionHorizon.toISOString();
    from = retentionHorizon;
  }
  // Window-end clamp (must end in the past) is the REST layer's job; we trust the caller here.

  // Repair fetch set = the operator's SELECTED venues: the per-op allow-list
  // (opts.sources) or, absent that, the per-currency formula TIMELINE union over
  // the window. Deliberately NOT getActiveFeeds (the LIVE available∩enabled set
  // — the wrong set for a deep repair: it dragged in venues with no deep data,
  // returning ~390k no_data sentinels). NOT minus getCurrentFormula and NOT minus
  // the Redis auto-ban overlay — repair is the remediation that fixes the gap a
  // ban caused, and the timeline is the per-currency source of truth (Stage 4).
  // Symbols come from currency_sources (the feed map), independent of `available`.
  const selectedSources = opts?.sources ?? await resolveRepairSources(currency, from, to);
  const feedMap = await getFeedMap(currency);
  const feeds: { source: string; symbol: string }[] = [];
  for (const source of selectedSources) {
    const fm = feedMap[source];
    if (!fm) {
      log(`[repair] ensureSourceCoverage: ${currency}/${source} has no symbol mapping in currency_sources — skipping`);
      continue;
    }
    feeds.push({ source, symbol: fm.symbol });
  }
  if (feeds.length === 0) {
    log(`[repair] ensureSourceCoverage: no selected venues with a symbol for ${currency} — nothing to fetch`);
  }

  let rowsFetched = 0;
  let sentinelsWritten = 0;
  let skipped = 0;
  let tilesSkipped = 0;
  const failedPerSource: Record<string, number> = {};
  // Out-of-history failures get aggregated, not logged per tile. Earliest tile
  // (start time) tracks where each source's accessible history begins.
  const outOfHistoryEarliest: Record<string, Date> = {};

  // Optionally delete 'no_data' sentinels in the window first so empty
  // minutes get re-fetched.
  if (opts?.retryEmpty) {
    const del = await query(
      `DELETE FROM candles_1m_sources
        WHERE "currency" = $3
          AND "timestamp" >= $1 AND "timestamp" < $2
          AND "rejectedReason" = 'no_data'`,
      [from, to, currency],
    );
    log(`[repair] ensureSourceCoverage: cleared ${del.rowCount ?? 0} 'no_data' sentinels`);
  }

  // Walk backward through [from, to) in ENSURE_TILE-minute chunks. Throttle
  // before each ACTUAL fetch (not each tile): fully-covered tiles are skipped
  // below with no fetch and must not burn the 5s pace, or the resume speedup is
  // lost. Mirrors the shipped backfillStableRates coverage-skip.
  let firstFetch = true;
  for (let tileEnd = to; tileEnd > from;) {
    if (opts?.signal?.aborted) {
      log("[repair] ensureSourceCoverage: cancelled");
      break;
    }

    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - ENSURE_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    // Coverage skip. A (currency, source) is fully covered for this tile when it
    // already has a row (real OR sentinel) for every one of the tile's `limit`
    // minutes — PK (currency,timestamp,source) means one row per minute, so
    // COUNT == limit ⟺ no holes. Fetch only sources with at least one hole; if
    // every fetch source is covered, skip the whole tile (no fetch, no throttle)
    // → a killed repair RESUMES instead of restarting at `to`. Rides the
    // (currency, timestamp) index.
    //   - retryEmpty bypasses the skip → fetch every source (the deleted
    //     'no_data' sentinels above are holes, so they get re-fetched).
    //   - on a coverage-query error, fall back to fetching all (fail toward
    //     doing the work, loudly) rather than silently skipping.
    let feedsToFetch = feeds;
    if (!opts?.retryEmpty) {
      try {
        const cov = await query(
          `SELECT source, COUNT(*)::int AS n
             FROM candles_1m_sources
            WHERE "currency" = $1
              AND "timestamp" >= $2 AND "timestamp" < $3
              AND source = ANY($4::text[])
            GROUP BY source`,
          [currency, tileStart, tileEnd, feeds.map((f) => f.source)],
        );
        const have: Record<string, number> = {};
        for (const r of cov.rows as { source: string; n: number }[]) have[r.source] = r.n;
        feedsToFetch = feeds.filter((f) => (have[f.source] ?? 0) < limit);
      } catch (err) {
        logError(`[repair] ensureSourceCoverage: coverage check failed for tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) — fetching all sources`, err);
        feedsToFetch = feeds;
      }
    }

    if (feedsToFetch.length === 0) {
      tilesSkipped++;
      tileEnd = tileStart;
      continue;
    }

    if (!firstFetch) {
      await new Promise((r) => setTimeout(r, TILE_THROTTLE_MS));
    }
    firstFetch = false;

    // Fan out per-source fetchRange for the sources that still have holes.
    const settled = await Promise.allSettled(
      feedsToFetch.map((f) => {
        recordApiRequest(currency, f.source, "repair");
        return ADAPTER_BY_NAME[f.source].fetchRange(f.symbol, tileEnd, limit);
      }),
    );

    // Per source, build the tile's rows (fetched candle or 'no_data' sentinel
    // per minute) and insert them in ONE batched statement instead of one
    // awaited round-trip per minute. ON CONFLICT DO NOTHING preserves existing
    // rows (live tick, prior heal, prior sentinel) exactly as the per-row loop
    // did; RETURNING "rejected" gives the precise fetched/sentinel/skipped split.
    for (let i = 0; i < feedsToFetch.length; i++) {
      const source = feedsToFetch[i].source;
      const res = settled[i];

      if (res.status === "rejected") {
        // Adapter-declared out-of-history (e.g. gate caps at ~6.9 days) is
        // expected, not a fault. Aggregate quietly; one summary line at end.
        if (isOutOfHistory(res.reason)) {
          const prev = outOfHistoryEarliest[source];
          if (!prev || tileStart < prev) outOfHistoryEarliest[source] = tileStart;
          continue;
        }
        failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
        logError(`[repair] ensureSourceCoverage: ${currency}/${source} tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) failed`, res.reason);
        // Don't write sentinels for whole-tile failures — that'd mark every
        // minute in the tile as 'no_data', losing the distinction between
        // "exchange returned empty" and "network/auth failure." The next
        // ensureSourceCoverage call will retry the tile.
        continue;
      }

      // Map fetched minutes for fast lookup.
      const fetched = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
      for (const { timestamp, candle } of res.value) {
        const ts = timestamp.getTime();
        if (ts < tileStartMs || ts >= tileEnd.getTime()) continue;
        fetched.set(ts, candle);
      }

      // Build column-arrays for the whole tile: a fetched candle, or a sentinel.
      const tsArr: Date[] = [];
      const oArr: number[] = [], hArr: number[] = [], lArr: number[] = [], cArr: number[] = [], vArr: number[] = [];
      const rejArr: boolean[] = [];
      const reasonArr: (string | null)[] = [];
      for (let minuteMs = tileStartMs; minuteMs < tileEnd.getTime(); minuteMs += 60000) {
        const candle = fetched.get(minuteMs);
        tsArr.push(new Date(minuteMs));
        if (candle) {
          oArr.push(candle.open); hArr.push(candle.high); lArr.push(candle.low); cArr.push(candle.close); vArr.push(candle.volume);
          rejArr.push(false); reasonArr.push(null);
        } else {
          oArr.push(0); hArr.push(0); lArr.push(0); cArr.push(0); vArr.push(0);
          rejArr.push(true); reasonArr.push("no_data");
        }
      }
      if (tsArr.length === 0) continue;

      const ins = await query(
        `INSERT INTO candles_1m_sources
           ("currency","timestamp","source","open","high","low","close","volume",
            "rejected","rejectedReason","usedInFormula")
         SELECT $1, u.ts, $2, u.open, u.high, u.low, u.close, u.volume, u.rejected, u.reason, NULL
           FROM UNNEST($3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[],
                       $7::numeric[], $8::numeric[], $9::boolean[], $10::text[])
                AS u(ts, open, high, low, close, volume, rejected, reason)
         ON CONFLICT ("currency","timestamp","source") DO NOTHING
         RETURNING "rejected"`,
        [currency, source, tsArr, oArr, hArr, lArr, cArr, vArr, rejArr, reasonArr],
      );

      const insertedRows = ins.rows as { rejected: boolean }[];
      for (const r of insertedRows) {
        if (r.rejected) sentinelsWritten++;
        else rowsFetched++;
      }
      skipped += tsArr.length - insertedRows.length;   // already present (ON CONFLICT DO NOTHING)
    }

    tileEnd = tileStart;
  }

  // One tidy summary line per source for the venues that ran out of history.
  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[repair] ensureSourceCoverage: ${currency}/${source} has no data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  const result: EnsureSourceCoverageResult = { rowsFetched, sentinelsWritten, skipped, tilesSkipped, failedPerSource };
  if (clamped.from || clamped.to) result.clamped = clamped;
  log(`[repair] ensureSourceCoverage: rowsFetched=${rowsFetched} sentinels=${sentinelsWritten} skipped=${skipped} tilesSkipped=${tilesSkipped} failures=${JSON.stringify(failedPerSource)}`);
  return result;
}

export interface RecomposeRangeResult {
  recomposed: number;
  skippedNoSources: number;
  failed: number;
  clamped?: { from?: string; to?: string };
}

export interface RecomposeRangeOpts {
  formula?: Formula;        // explicit per-op override; absent → per-minute formula timeline (Stage 3). Never writes formula_changes.
  signal?: AbortSignal;     // honored at minute granularity
}

/**
 * Re-derive candles_1m for every minute in [from, to) using the supplied
 * formula. Pure DB work — no exchange fetches. The override formula is
 * windowed-only; live formula state in formula_changes is untouched.
 */
export async function recomposeRange(
  currency: string,
  from: Date,
  to: Date,
  opts?: RecomposeRangeOpts,
): Promise<RecomposeRangeResult> {
  const retentionHorizon = new Date(Date.now() - await getRepairHorizonMs());
  const clamped: RecomposeRangeResult["clamped"] = {};
  if (from < retentionHorizon) {
    clamped.from = retentionHorizon.toISOString();
    from = retentionHorizon;
  }

  // Formula resolution. An explicit per-op override (scripts/recompose.ts, the
  // repair UI's allow-list) wins for EVERY minute. Otherwise resolve the
  // per-currency timeline AS-OF each minute — never getCurrentFormula() for a
  // historical minute (the live head / auto-ban overlay must not rewrite
  // history). A window straddling a breakpoint composes each segment with its
  // own as-of formula.
  const overrideFormula = opts?.formula ?? null;
  let timeline: FormulaVersion[] = [];
  if (!overrideFormula) {
    timeline = await ensureSeededTimeline(currency);
    if (timeline.length === 0) {
      log(`[repair] recomposeRange: ${currency} has no formula timeline and no live effective feeds — nothing to recompose`);
      const empty: RecomposeRangeResult = {
        recomposed: 0,
        skippedNoSources: Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000)),
        failed: 0,
      };
      if (clamped.from || clamped.to) empty.clamped = clamped;
      return empty;
    }
  }

  const meta           = await getCurrency(currency);
  const minSources     = meta?.minSources ?? await getSettingInt("minSources", 3);
  const baseline       = await getSourceCountBaseline(currency);
  const volumeLeader   = await getTrailingVolumeLeader(currency, 10);
  const premiumEnabled = meta?.premiumEnabled ?? true;

  let recomposed = 0;
  let skippedNoSources = 0;
  let failed = 0;

  for (let minuteMs = from.getTime(); minuteMs < to.getTime(); minuteMs += 60000) {
    if (opts?.signal?.aborted) {
      log("[repair] recomposeRange: cancelled");
      break;
    }
    const minuteTs = new Date(minuteMs);
    let formula: Formula;
    if (overrideFormula) {
      formula = overrideFormula;
    } else {
      const sources = resolveFormulaAt(timeline, minuteTs);
      if (!sources) {
        // Post-seed this can't happen (epoch baseline covers all history); fail
        // loud rather than silently composing from the wrong set.
        throw new Error(`[repair] recomposeRange: no formula version covers ${minuteTs.toISOString()} for ${currency}`);
      }
      formula = toExcludedSources(sources);
    }
    try {
      const result = await composeMinute(currency, minuteTs, formula, {
        baseline, minSources, volumeLeader: volumeLeader ?? undefined, premiumEnabled,
      });
      if (result.composed) recomposed++;
      else skippedNoSources++;
    } catch (err) {
      logError(`[repair] recomposeRange: ${minuteTs.toISOString()} failed`, err);
      failed++;
    }
  }

  // Reconcile the gaps table: recomposeRange writes candles_1m directly and never
  // touches gap state, so any gap whose minute we just filled must be flipped to
  // healed or it lingers as a stale 'unresolvable'/'detected' row.
  const reconciled = await reconcileHealedGaps(currency, from, to);

  const result: RecomposeRangeResult = { recomposed, skippedNoSources, failed };
  if (clamped.from || clamped.to) result.clamped = clamped;
  log(`[repair] recomposeRange: recomposed=${recomposed} skipped=${skippedNoSources} failed=${failed} gapsReconciled=${reconciled}`);
  return result;
}

export interface RepairRangeOpts {
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;
  signal?: AbortSignal;
}

export interface RepairRangeResult {
  ensure: EnsureSourceCoverageResult;
  recompose: RecomposeRangeResult;
}

/**
 * Convenience: ensureSourceCoverage then recomposeRange. Caller picks the
 * formula override (applied only to the recompose phase) and the per-source
 * fetch set (applied only to the ensure phase).
 */
export async function repairRange(
  currency: string,
  from: Date,
  to: Date,
  opts?: RepairRangeOpts,
): Promise<RepairRangeResult> {
  const ensure = await ensureSourceCoverage(currency, from, to, {
    sources: opts?.sources,
    retryEmpty: opts?.retryEmpty,
    signal: opts?.signal,
  });
  if (opts?.signal?.aborted) {
    return { ensure, recompose: { recomposed: 0, skippedNoSources: 0, failed: 0 } };
  }
  const recompose = await recomposeRange(currency, from, to, {
    formula: opts?.formula,
    signal: opts?.signal,
  });
  return { ensure, recompose };
}
