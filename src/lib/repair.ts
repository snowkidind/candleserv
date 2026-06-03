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
import { getExchangeTuning } from "./exchangeConfig.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";

// Tile size / throttle / timeout are now PER VENUE, read from exchange_config.json
// (getExchangeTuning) — a 1000-row venue no longer crawls at a 300-cap venue's
// pace. See Stage 5 of plans/candleserv-repair-rework.md.

/**
 * Bound a single adapter fetch to the venue's timeout_ms. A timeout rejects so
 * the per-venue walk treats it as a reachability failure (fail loud, skip venue
 * for the run). Pure wall-clock on an HTTP fetch — behaves identically in sim
 * and prod (no candle-time dependence).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`fetch timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(timer); res(v); },
      (e) => { clearTimeout(timer); rej(e); },
    );
  });
}

export interface EnsureSourceCoverageResult {
  rowsFetched: number;
  sentinelsWritten: number;
  skipped: number;
  tilesSkipped: number;       // tiles already fully covered for every fetch source → no fetch/throttle
  failedPerSource: Record<string, number>;
  clamped?: { from?: string; to?: string }; // ISO timestamps after clamping
}

export interface EnsureSourceCoverageOpts {
  sources?: string[];        // default: all formula-included adapters
  retryEmpty?: boolean;      // default: false; if true, delete 'no_data' sentinels in the window first
  overwriteExisting?: boolean; // Stage 6 (repairExistingTokenMinutes): bypass coverage-skip + ON CONFLICT DO UPDATE — re-fetch and overwrite existing rows. OFF (default) = coverage-skip + DO NOTHING (fast, resumable, fills only holes).
  signal?: AbortSignal;      // honored at tile boundaries for cancellation
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

  // Per-venue independent walks. Each venue uses its OWN tile_size / throttle_ms
  // / timeout_ms (exchange_config.json) and is clamped to its OWN probed candle
  // depth, so a 1000-row venue isn't paced at a 300-cap venue's cadence and no
  // venue is blindly polled past the history it serves. Walks run concurrently
  // across venues (the per-venue rate gate in the registry serializes same-venue
  // calls); shared counters are mutated synchronously on the single event loop.
  const nowMs = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const overwriteExisting = opts?.overwriteExisting ?? false;

  async function walkVenue(source: string, symbol: string): Promise<void> {
    let cfg;
    try {
      cfg = getExchangeTuning(source);
    } catch (err) {
      failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
      logError(`[repair] ensureSourceCoverage: ${currency}/${source} has no exchange_config tuning — skipping venue`, err);
      return;
    }
    const tile = cfg.tile_size;

    // Depth pre-flight (candle): clamp this venue's fetch start to the history it
    // actually serves, so we never blindly request a window it can't (blind 400s).
    let venueFrom = from;
    const depthMin = cfg.candle_depth_minutes?.[currency];
    if (depthMin != null) {
      const depthFloor = new Date(nowMs - depthMin * 60000);
      if (venueFrom < depthFloor) {
        log(`[repair] ensureSourceCoverage: ${currency}/${source} window starts before its ${depthMin}m candle depth — clamping fetch start to ${depthFloor.toISOString().slice(0, 16)} (out-of-depth segment skipped)`);
        venueFrom = depthFloor;
      }
    }
    if (venueFrom >= to) {
      log(`[repair] ensureSourceCoverage: ${currency}/${source} entire window is deeper than its candle depth — skipping venue`);
      return;
    }

    let firstFetch = true;
    for (let tileEnd = to; tileEnd > venueFrom;) {
      if (opts?.signal?.aborted) { log(`[repair] ensureSourceCoverage: ${source} cancelled`); return; }

      const tileStartMs = Math.max(venueFrom.getTime(), tileEnd.getTime() - tile * 60000);
      const tileStart   = new Date(tileStartMs);
      const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

      // Coverage skip for THIS source: a tile already holding `limit` rows (real
      // or sentinel) has no holes → skip (no fetch, no throttle), so a killed
      // repair resumes. PK (currency,timestamp,source) ⇒ COUNT == limit ⟺ full.
      //   - retryEmpty / overwriteExisting bypass it (force a re-fetch).
      //   - a coverage-query error fetches anyway (fail toward doing the work).
      if (!opts?.retryEmpty && !overwriteExisting) {
        try {
          const cov = await query(
            `SELECT COUNT(*)::int AS n FROM candles_1m_sources
              WHERE "currency"=$1 AND "timestamp">=$2 AND "timestamp"<$3 AND source=$4`,
            [currency, tileStart, tileEnd, source],
          );
          if (Number(cov.rows[0]?.n ?? 0) >= limit) { tilesSkipped++; tileEnd = tileStart; continue; }
        } catch (err) {
          logError(`[repair] ensureSourceCoverage: ${currency}/${source} coverage check failed for tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) — fetching`, err);
        }
      }

      if (!firstFetch) await sleep(cfg.throttle_ms);
      firstFetch = false;

      let rows: { timestamp: Date; candle: { open: number; high: number; low: number; close: number; volume: number } }[];
      try {
        recordApiRequest(currency, source, "repair");
        // Fetch one extra minute (limit + 1): binance/bybit/bitget include the
        // endTime minute and drop the BOTTOM of the window, so plain `limit` loses
        // each tile's first minute (tileStart). DO-NOTHING masked this (the dropped
        // minute kept its existing row); DO-UPDATE would clobber it to a sentinel.
        // The [tileStartMs, tileEnd) filter below trims the overlap. Mirrors
        // backfillStableRates' limit+1.
        rows = await withTimeout(
          ADAPTER_BY_NAME[source].fetchRange(symbol, tileEnd, limit + 1),
          cfg.timeout_ms,
          `${currency}/${source} tile ${tileStart.toISOString().slice(0, 16)}`,
        );
      } catch (err) {
        if (isOutOfHistory(err)) {
          // Reached the venue's history floor — everything deeper is also out of
          // history, so stop this venue's walk. (Depth pre-flight usually clamps
          // before this; it's the backstop when a depth is unknown/stale.)
          const prev = outOfHistoryEarliest[source];
          if (!prev || tileStart < prev) outOfHistoryEarliest[source] = tileStart;
          return;
        }
        // Reachability / timeout / other — fail LOUD, per-venue: skip this venue
        // for the run (runtime reachability is region-dependent, NOT a venue
        // property; never a silent drop). The coverage-skip resumes on re-run.
        failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
        logError(`[repair] ensureSourceCoverage: ${currency}/${source} tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) failed — skipping ${source} for this run (re-run resumes)`, err);
        return;
      }

      // Build the tile's rows (fetched candle or 'no_data' sentinel per minute)
      // and insert in ONE batched statement. ON CONFLICT DO NOTHING preserves
      // existing rows; RETURNING "rejected" gives the fetched/sentinel/skipped split.
      const fetched = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
      for (const { timestamp, candle } of rows) {
        const ts = timestamp.getTime();
        if (ts < tileStartMs || ts >= tileEnd.getTime()) continue;
        fetched.set(ts, candle);
      }
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
      if (tsArr.length > 0) {
        // OFF: DO NOTHING (preserve existing rows; RETURNING yields only inserts,
        // so the difference is `skipped`). ON (overwriteExisting): DO UPDATE
        // overwrites the OHLCV/verdict and resets usedInFormula (recompose re-sets
        // it), so every row is (re)written and skipped stays 0.
        const conflict = overwriteExisting
          ? `DO UPDATE SET "open"=EXCLUDED."open", "high"=EXCLUDED."high", "low"=EXCLUDED."low", "close"=EXCLUDED."close", "volume"=EXCLUDED."volume", "rejected"=EXCLUDED."rejected", "rejectedReason"=EXCLUDED."rejectedReason", "usedInFormula"=NULL`
          : `DO NOTHING`;
        const ins = await query(
          `INSERT INTO candles_1m_sources
             ("currency","timestamp","source","open","high","low","close","volume",
              "rejected","rejectedReason","usedInFormula")
           SELECT $1, u.ts, $2, u.open, u.high, u.low, u.close, u.volume, u.rejected, u.reason, NULL
             FROM UNNEST($3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[],
                         $7::numeric[], $8::numeric[], $9::boolean[], $10::text[])
                  AS u(ts, open, high, low, close, volume, rejected, reason)
           ON CONFLICT ("currency","timestamp","source") ${conflict}
           RETURNING "rejected"`,
          [currency, source, tsArr, oArr, hArr, lArr, cArr, vArr, rejArr, reasonArr],
        );
        const insertedRows = ins.rows as { rejected: boolean }[];
        for (const r of insertedRows) {
          if (r.rejected) sentinelsWritten++;
          else rowsFetched++;
        }
        skipped += tsArr.length - insertedRows.length;   // >0 only in DO NOTHING mode (rows already present)
      }

      tileEnd = tileStart;
    }
  }

  await Promise.all(feeds.map((f) => walkVenue(f.source, f.symbol)));

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
