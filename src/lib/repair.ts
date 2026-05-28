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
 * All three are hard-bounded by the 180-day retention window. Window-end
 * clamps are the caller's responsibility (the REST handler enforces them).
 */
import { ADAPTER_BY_NAME, SOURCE_NAMES } from "../adapters/registry.js";
import { symbolFor } from "../adapters/symbolMap.js";
import { isOutOfHistory } from "../adapters/errors.js";
import { composeMinute } from "./compose.js";
import type { Formula } from "./compose.js";
import {
  getSourceCountBaseline,
  getTrailingVolumeLeader,
} from "../db/candles.js";
import { getCurrentFormula } from "../db/formulaChanges.js";
import { getSettingInt } from "../db/appSettings.js";
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
 * Hard-clamped to the 180-day retention window. Existing rows are never
 * overwritten (ON CONFLICT DO NOTHING).
 */
export async function ensureSourceCoverage(
  from: Date,
  to: Date,
  opts?: EnsureSourceCoverageOpts,
): Promise<EnsureSourceCoverageResult> {
  // Clamp to retention horizon.
  const retentionHorizon = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const clamped: EnsureSourceCoverageResult["clamped"] = {};
  if (from < retentionHorizon) {
    clamped.from = retentionHorizon.toISOString();
    from = retentionHorizon;
  }
  // Window-end clamp (must end in the past) is the REST layer's job; we trust the caller here.

  const excluded = new Set(getCurrentFormula().excludedSources);
  const sources = (opts?.sources ?? SOURCE_NAMES).filter((s) => !excluded.has(s));

  let rowsFetched = 0;
  let sentinelsWritten = 0;
  let skipped = 0;
  const failedPerSource: Record<string, number> = {};
  // Out-of-history failures get aggregated, not logged per tile. Earliest tile
  // (start time) tracks where each source's accessible history begins.
  const outOfHistoryEarliest: Record<string, Date> = {};

  // Optionally delete 'no_data' sentinels in the window first so empty
  // minutes get re-fetched.
  if (opts?.retryEmpty) {
    const del = await query(
      `DELETE FROM candles_1m_sources
        WHERE "currency" = 'BTC'
          AND "timestamp" >= $1 AND "timestamp" < $2
          AND "rejectedReason" = 'no_data'`,
      [from, to],
    );
    log(`[repair] ensureSourceCoverage: cleared ${del.rowCount ?? 0} 'no_data' sentinels`);
  }

  // Walk backward through [from, to) in ENSURE_TILE-minute chunks.
  let firstTile = true;
  for (let tileEnd = to; tileEnd > from;) {
    if (opts?.signal?.aborted) {
      log("[repair] ensureSourceCoverage: cancelled");
      break;
    }
    if (!firstTile) {
      await new Promise((r) => setTimeout(r, TILE_THROTTLE_MS));
    }
    firstTile = false;

    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - ENSURE_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    // Fan out per-source fetchRange for this tile.
    const settled = await Promise.allSettled(
      sources.map((s) => ADAPTER_BY_NAME[s].fetchRange(symbolFor("BTC", s), tileEnd, limit)),
    );

    // Per (minute, source), either insert fetched candle or sentinel.
    // ON CONFLICT DO NOTHING preserves existing rows (live tick, prior heal,
    // prior sentinel that wasn't retryEmpty-cleared).
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
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
        logError(`[repair] ensureSourceCoverage: ${source} tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) failed`, res.reason);
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

      // For each minute in [tileStart, tileEnd): insert candle or sentinel.
      for (let minuteMs = tileStartMs; minuteMs < tileEnd.getTime(); minuteMs += 60000) {
        const candle = fetched.get(minuteMs);
        if (candle) {
          const ins = await query(
            `INSERT INTO candles_1m_sources
               ("currency","timestamp","source","open","high","low","close","volume",
                "rejected","rejectedReason","usedInFormula")
             VALUES ('BTC',$1,$2,$3,$4,$5,$6,$7,false,NULL,NULL)
             ON CONFLICT ("currency","timestamp","source") DO NOTHING`,
            [new Date(minuteMs), source, candle.open, candle.high, candle.low, candle.close, candle.volume],
          );
          if (ins.rowCount === 1) rowsFetched++;
          else skipped++;
        } else {
          const ins = await query(
            `INSERT INTO candles_1m_sources
               ("currency","timestamp","source","open","high","low","close","volume",
                "rejected","rejectedReason","usedInFormula")
             VALUES ('BTC',$1,$2,0,0,0,0,0,true,'no_data',NULL)
             ON CONFLICT ("currency","timestamp","source") DO NOTHING`,
            [new Date(minuteMs), source],
          );
          if (ins.rowCount === 1) sentinelsWritten++;
          else skipped++;
        }
      }
    }

    tileEnd = tileStart;
  }

  // One tidy summary line per source for the venues that ran out of history.
  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[repair] ensureSourceCoverage: ${source} has no data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  const result: EnsureSourceCoverageResult = { rowsFetched, sentinelsWritten, skipped, failedPerSource };
  if (clamped.from || clamped.to) result.clamped = clamped;
  log(`[repair] ensureSourceCoverage: rowsFetched=${rowsFetched} sentinels=${sentinelsWritten} skipped=${skipped} failures=${JSON.stringify(failedPerSource)}`);
  return result;
}

export interface RecomposeRangeResult {
  recomposed: number;
  skippedNoSources: number;
  failed: number;
  clamped?: { from?: string; to?: string };
}

export interface RecomposeRangeOpts {
  formula?: Formula;        // default: getCurrentFormula() — does NOT write to formula_changes
  signal?: AbortSignal;     // honored at minute granularity
}

/**
 * Re-derive candles_1m for every minute in [from, to) using the supplied
 * formula. Pure DB work — no exchange fetches. The override formula is
 * windowed-only; live formula state in formula_changes is untouched.
 */
export async function recomposeRange(
  from: Date,
  to: Date,
  opts?: RecomposeRangeOpts,
): Promise<RecomposeRangeResult> {
  const retentionHorizon = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const clamped: RecomposeRangeResult["clamped"] = {};
  if (from < retentionHorizon) {
    clamped.from = retentionHorizon.toISOString();
    from = retentionHorizon;
  }

  const formula = opts?.formula ?? getCurrentFormula();
  const minSources   = await getSettingInt("minSources", 3);
  const baseline     = await getSourceCountBaseline("BTC");
  const volumeLeader = await getTrailingVolumeLeader("BTC", 10);

  let recomposed = 0;
  let skippedNoSources = 0;
  let failed = 0;

  for (let minuteMs = from.getTime(); minuteMs < to.getTime(); minuteMs += 60000) {
    if (opts?.signal?.aborted) {
      log("[repair] recomposeRange: cancelled");
      break;
    }
    const minuteTs = new Date(minuteMs);
    try {
      const result = await composeMinute("BTC", minuteTs, formula, {
        baseline, minSources, volumeLeader: volumeLeader ?? undefined,
      });
      if (result.composed) recomposed++;
      else skippedNoSources++;
    } catch (err) {
      logError(`[repair] recomposeRange: ${minuteTs.toISOString()} failed`, err);
      failed++;
    }
  }

  const result: RecomposeRangeResult = { recomposed, skippedNoSources, failed };
  if (clamped.from || clamped.to) result.clamped = clamped;
  log(`[repair] recomposeRange: recomposed=${recomposed} skipped=${skippedNoSources} failed=${failed}`);
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
  from: Date,
  to: Date,
  opts?: RepairRangeOpts,
): Promise<RepairRangeResult> {
  const ensure = await ensureSourceCoverage(from, to, {
    sources: opts?.sources,
    retryEmpty: opts?.retryEmpty,
    signal: opts?.signal,
  });
  if (opts?.signal?.aborted) {
    return { ensure, recompose: { recomposed: 0, skippedNoSources: 0, failed: 0 } };
  }
  const recompose = await recomposeRange(from, to, {
    formula: opts?.formula,
    signal: opts?.signal,
  });
  return { ensure, recompose };
}
