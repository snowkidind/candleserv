/**
 * Stable-rate backfill.
 *
 * For each USDT venue (binance, bybit, bitget, gate), fetches the venue's
 * local USDT→USD rate over a window via its adapter's pegFetcherRange and
 * persists rows into stable_rates_1m_sources. The insert is guarded by a
 * WHERE EXISTS check against candles_1m_sources so the FK is never tripped
 * — minutes where the BTC archive has gaps are silently skipped.
 *
 * Walks tiles backward in the same chunking pattern as repair.ts's
 * ensureSourceCoverage (300-minute tiles, 5s throttle, abort-signal
 * honored at tile boundaries). USD-native venues (coinbase, kraken,
 * bitfinex, okx) are skipped — their pegFetcherRange is null.
 *
 * Coverage skip: stable rates are SHARED per (minute, source) across every
 * currency, so an overlapping repair (or a prior BTC fill) may already have the
 * rows. Each tile only fetches the venues that actually have a hole (a source
 * candle with no rate row yet); a fully-covered tile is skipped with no fetch
 * and no throttle, so re-running over already-done windows shreds through.
 * `retryEmpty` bypasses the skip to force a full re-fetch (e.g. to correct a
 * bad rate).
 */
import { ADAPTER_BY_NAME, SOURCE_NAMES } from "../adapters/registry.js";
import { isOutOfHistory } from "../adapters/errors.js";
import { resolveRepairSources } from "../db/formulaVersions.js";
import { getExchangeTuning } from "./exchangeConfig.js";
import { getRepairHorizonMs } from "./retention.js";
import { query } from "../db/pool.js";
import { log, logError, logWarn } from "./log.js";

// Tile size / throttle / timeout are PER VENUE, from exchange_config.json
// (getExchangeTuning). Peg depth is a separate gate (below).

/** Bound a single peg fetch to the venue's timeout_ms (see repair.ts withTimeout). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`peg fetch timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(timer); res(v); },
      (e) => { clearTimeout(timer); rej(e); },
    );
  });
}

export interface BackfillStableRatesResult {
  rowsInserted: number;
  rowsSkippedNoBtc: number;       // rate fetched but no BTC row → skipped (FK-safe)
  tilesSkipped: number;           // tiles already fully covered → no fetch issued
  failedPerSource: Record<string, number>;
  clamped?: { from?: string };
}

export interface BackfillStableRatesOpts {
  sources?: string[];             // default: all USDT venues
  currency?: string;              // repair's currency — scopes the coverage skip to its candle rows (index-efficient); without it the skip is disabled
  retryEmpty?: boolean;           // bypass the coverage skip → re-fetch every venue/tile
  signal?: AbortSignal;
}

export async function backfillStableRates(
  from: Date,
  to: Date,
  opts?: BackfillStableRatesOpts,
): Promise<BackfillStableRatesResult> {
  // Clamp to the repair horizon (repairHorizonDays app_setting, default 180d).
  const retentionHorizon = new Date(Date.now() - await getRepairHorizonMs());
  const clamped: BackfillStableRatesResult["clamped"] = {};
  if (from < retentionHorizon) {
    clamped.from = retentionHorizon.toISOString();
    from = retentionHorizon;
  }

  // Venue set = the per-op allow-list, else the per-currency formula TIMELINE
  // union over the window (the repair's selected venues — NOT the full
  // SOURCE_NAMES default, which would fetch pegs for venues this repair never
  // composes). Falls back to SOURCE_NAMES only for a direct call with no currency
  // (no timeline to resolve). USDT-only filter still applies below.
  const requested = opts?.sources
    ?? (opts?.currency ? await resolveRepairSources(opts.currency, from, to) : SOURCE_NAMES);
  const usdtSources = requested.filter((name) => {
    const a = ADAPTER_BY_NAME[name];
    return a?.normalize.pegFetcherRange != null;
  });

  if (usdtSources.length === 0) {
    log("[stableRateBackfill] no USDT venues in source set — nothing to do");
    return { rowsInserted: 0, rowsSkippedNoBtc: 0, tilesSkipped: 0, failedPerSource: {} };
  }

  let rowsInserted = 0;
  let rowsSkippedNoBtc = 0;
  let tilesSkipped = 0;   // tiles whose rate rows were already fully covered → no fetch
  const failedPerSource: Record<string, number> = {};
  const outOfHistoryEarliest: Record<string, Date> = {};

  const retryEmpty = opts?.retryEmpty ?? false;
  const nowMs = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Per-venue independent peg walks (own tile_size / throttle_ms / timeout_ms),
  // each clamped to its own probed PEG depth. Peg depth is a SEPARATE gate from
  // candle depth: a USDT venue can have deep candles but a shallow peg, so beyond
  // peg depth it can't be USD-normalized (missing_paired_rate). The pre-flight
  // FLAGS that segment so the operator omits the venue from the formula there,
  // rather than discovering missing_paired_rate mid-run.
  async function walkPegVenue(source: string): Promise<void> {
    let cfg;
    try {
      cfg = getExchangeTuning(source);
    } catch (err) {
      failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
      logError(`[stableRateBackfill] ${source} has no exchange_config tuning — skipping venue`, err);
      return;
    }
    const tile = cfg.tile_size;
    const fetchPeg = ADAPTER_BY_NAME[source].normalize.pegFetcherRange!;
    const pegSourcePair = ADAPTER_BY_NAME[source].normalize.pegSourcePair;
    if (!pegSourcePair) return; // shouldn't happen given the USDT filter, but defensive

    // Peg-depth pre-flight.
    let venueFrom = from;
    const pegDepth = cfg.peg_depth_minutes;
    if (pegDepth != null) {
      const depthFloor = new Date(nowMs - pegDepth * 60000);
      if (venueFrom < depthFloor) {
        logWarn(`[stableRateBackfill] ${source} peg depth ${pegDepth}m is shallower than the window — clamping peg fetch to ${depthFloor.toISOString().slice(0, 16)}. Minutes before that can't be USD-normalized for ${source} (missing_paired_rate); omit ${source} from the formula for that segment.`);
        venueFrom = depthFloor;
      }
    }
    if (venueFrom >= to) {
      logWarn(`[stableRateBackfill] ${source} entire window is deeper than its ${pegDepth}m peg depth — skipping venue (omit it from the formula for this window)`);
      return;
    }

    let firstFetch = true;
    for (let tileEnd = to; tileEnd > venueFrom;) {
      if (opts?.signal?.aborted) { log(`[stableRateBackfill] ${source} cancelled`); return; }

      const tileStartMs = Math.max(venueFrom.getTime(), tileEnd.getTime() - tile * 60000);
      const tileStart   = new Date(tileStartMs);
      const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

      // Coverage skip (per source): fetch only if a candle minute this repair's
      // currency holds still lacks a rate row. Needs opts.currency to ride the
      // (currency, timestamp) index; retryEmpty / no-currency disables the skip.
      if (!retryEmpty && opts?.currency) {
        try {
          const cov = await query(
            `SELECT 1 FROM candles_1m_sources cs
              WHERE cs.currency = $1 AND cs."timestamp" >= $2 AND cs."timestamp" < $3 AND cs.source = $4
                AND NOT EXISTS (
                  SELECT 1 FROM stable_rates_1m_sources sr
                   WHERE sr."timestamp" = cs."timestamp" AND sr.source = cs.source)
              LIMIT 1`,
            [opts.currency, tileStart, tileEnd, source],
          );
          if (cov.rows.length === 0) { tilesSkipped++; tileEnd = tileStart; continue; }
        } catch (err) {
          logError(`[stableRateBackfill] ${source} coverage check failed for tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) — fetching`, err);
        }
      }

      if (!firstFetch) await sleep(cfg.throttle_ms);
      firstFetch = false;

      // Fetch one extra minute (limit+1): binance/bybit/bitget include the endTime
      // minute and drop the bottom of the window; without +1 every tile boundary
      // loses its first minute (the recurring :47 hole). The [tileStartMs, tileEnd)
      // filter trims the overlap; the upsert makes it idempotent.
      let rows: { timestamp: Date; rate: number }[];
      try {
        rows = await withTimeout(fetchPeg(tileEnd, limit + 1), cfg.timeout_ms, `${source} peg tile ${tileStart.toISOString().slice(0, 16)}`);
      } catch (err) {
        if (isOutOfHistory(err)) {
          const prev = outOfHistoryEarliest[source];
          if (!prev || tileStart < prev) outOfHistoryEarliest[source] = tileStart;
          return; // history floor — everything deeper is also out of history
        }
        failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
        logError(`[stableRateBackfill] ${source} peg tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) failed — skipping ${source} for this run (re-run resumes)`, err);
        return;
      }

      for (const { timestamp, rate } of rows) {
        const ts = timestamp.getTime();
        if (ts < tileStartMs || ts >= tileEnd.getTime()) continue;
        // Insert only if the FK target (BTC row) exists; ON CONFLICT updates.
        const ins = await query(
          `INSERT INTO stable_rates_1m_sources ("timestamp", "source", "rate", "pegSourcePair")
           SELECT $1::timestamptz, $2::varchar, $3::numeric, $4::varchar
            WHERE EXISTS (
              SELECT 1 FROM candles_1m_sources
               WHERE "timestamp" = $1::timestamptz AND source = $2::varchar
            )
           ON CONFLICT ("timestamp","source") DO UPDATE SET
             rate = EXCLUDED.rate,
             "pegSourcePair" = EXCLUDED."pegSourcePair",
             "updatedAt" = NOW()`,
          [timestamp, source, rate, pegSourcePair],
        );
        if (ins.rowCount === 1) rowsInserted++;
        else rowsSkippedNoBtc++;
      }

      tileEnd = tileStart;
    }
  }

  await Promise.all(usdtSources.map(walkPegVenue));

  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[stableRateBackfill] ${source} has no rate data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  const result: BackfillStableRatesResult = { rowsInserted, rowsSkippedNoBtc, tilesSkipped, failedPerSource };
  if (clamped.from) result.clamped = clamped;
  log(`[stableRateBackfill] rowsInserted=${rowsInserted} rowsSkippedNoBtc=${rowsSkippedNoBtc} tilesSkipped=${tilesSkipped} failures=${JSON.stringify(failedPerSource)}`);
  return result;
}
