/**
 * Stable-rate backfill — Phase 5 of candleserv-stablecoin-aware-index.
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
import { getRepairHorizonMs } from "./retention.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";

const BACKFILL_TILE = 300;
const TILE_THROTTLE_MS = 5000;

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

  // USDT venues only — drop anything with pegFetcherRange === null.
  const requested = opts?.sources ?? SOURCE_NAMES;
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

  // Throttle before each ACTUAL fetch, not each tile — fully-covered tiles are
  // skipped below and must not burn the 5s pace or we lose the speedup.
  let firstFetch = true;
  for (let tileEnd = to; tileEnd > from; ) {
    if (opts?.signal?.aborted) {
      log("[stableRateBackfill] cancelled");
      break;
    }

    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    // Coverage skip. Stable rates are SHARED per (minute, source), so a prior
    // repair (or BTC's live fill) may already hold this tile. Fetch a venue ONLY
    // where a minute the REPAIR'S CURRENCY has a candle for still lacks a rate
    // row — a real hole the FK-guarded insert could fill. The rate table is
    // shared, so a rate another currency already filled counts as covered; the
    // currency scope just limits which candle minutes we ask about (the ones
    // this repair needs) AND lets the query ride the (currency, timestamp DESC)
    // index instead of seq-scanning per tile. Converges: once a hole is filled
    // it stops being selected. Fully-covered tile → skipped (no fetch, no
    // throttle).
    //   - retryEmpty, or no currency supplied (can't use the index), disables
    //     the skip → fetch every venue (current behavior).
    //   - on a coverage-query error, fall back to fetching all venues (fail
    //     toward doing the work, loudly) rather than silently skipping.
    let sourcesToFetch: string[];
    if (retryEmpty || !opts?.currency) {
      sourcesToFetch = usdtSources;
    } else {
      try {
        const cov = await query(
          `SELECT DISTINCT cs.source
             FROM candles_1m_sources cs
            WHERE cs.currency = $4
              AND cs."timestamp" >= $1 AND cs."timestamp" < $2
              AND cs.source = ANY($3::text[])
              AND NOT EXISTS (
                SELECT 1 FROM stable_rates_1m_sources sr
                 WHERE sr."timestamp" = cs."timestamp" AND sr.source = cs.source
              )`,
          [tileStart, tileEnd, usdtSources, opts.currency],
        );
        sourcesToFetch = cov.rows.map((r: { source: string }) => r.source);
      } catch (err) {
        logError(`[stableRateBackfill] coverage check failed for tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) — fetching all USDT venues`, err);
        sourcesToFetch = usdtSources;
      }
    }

    if (sourcesToFetch.length === 0) {
      tilesSkipped++;
      tileEnd = tileStart;
      continue;
    }

    if (!firstFetch) {
      await new Promise((r) => setTimeout(r, TILE_THROTTLE_MS));
    }
    firstFetch = false;

    // Fan out per-venue pegFetcherRange for this tile. Fetch one extra minute
    // (limit+1): binance/bybit/bitget include the endTime minute and drop the
    // bottom of the window, so without the +1 every 300-min tile boundary loses
    // its first minute (the recurring :47 stable-rate hole). The [tileStartMs,
    // tileEnd) filter below trims the overlap; the upsert makes it idempotent.
    const settled = await Promise.allSettled(
      sourcesToFetch.map((name) => {
        const a = ADAPTER_BY_NAME[name];
        return a.normalize.pegFetcherRange!(tileEnd, limit + 1);
      }),
    );

    for (let i = 0; i < sourcesToFetch.length; i++) {
      const source = sourcesToFetch[i];
      const res = settled[i];

      if (res.status === "rejected") {
        if (isOutOfHistory(res.reason)) {
          const prev = outOfHistoryEarliest[source];
          if (!prev || tileStart < prev) outOfHistoryEarliest[source] = tileStart;
          continue;
        }
        failedPerSource[source] = (failedPerSource[source] ?? 0) + 1;
        logError(`[stableRateBackfill] ${source} tile [${tileStart.toISOString()}, ${tileEnd.toISOString()}) failed`, res.reason);
        continue;
      }

      const pegSourcePair = ADAPTER_BY_NAME[source]?.normalize.pegSourcePair;
      if (!pegSourcePair) continue;     // shouldn't happen given the USDT filter, but defensive

      for (const { timestamp, rate } of res.value) {
        const ts = timestamp.getTime();
        if (ts < tileStartMs || ts >= tileEnd.getTime()) continue;

        // Single statement: insert only if the FK target (BTC row) exists.
        // ON CONFLICT updates the rate on existing rows (later re-runs win).
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
    }

    tileEnd = tileStart;
  }

  for (const [source, earliest] of Object.entries(outOfHistoryEarliest)) {
    log(`[stableRateBackfill] ${source} has no rate data before ${earliest.toISOString().slice(0, 16)} (skipped)`);
  }

  const result: BackfillStableRatesResult = { rowsInserted, rowsSkippedNoBtc, tilesSkipped, failedPerSource };
  if (clamped.from) result.clamped = clamped;
  log(`[stableRateBackfill] rowsInserted=${rowsInserted} rowsSkippedNoBtc=${rowsSkippedNoBtc} tilesSkipped=${tilesSkipped} failures=${JSON.stringify(failedPerSource)}`);
  return result;
}
