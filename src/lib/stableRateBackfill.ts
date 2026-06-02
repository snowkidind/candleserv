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
  failedPerSource: Record<string, number>;
  clamped?: { from?: string };
}

export interface BackfillStableRatesOpts {
  sources?: string[];             // default: all USDT venues
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
    return { rowsInserted: 0, rowsSkippedNoBtc: 0, failedPerSource: {} };
  }

  let rowsInserted = 0;
  let rowsSkippedNoBtc = 0;
  const failedPerSource: Record<string, number> = {};
  const outOfHistoryEarliest: Record<string, Date> = {};

  let firstTile = true;
  for (let tileEnd = to; tileEnd > from; ) {
    if (opts?.signal?.aborted) {
      log("[stableRateBackfill] cancelled");
      break;
    }
    if (!firstTile) {
      await new Promise((r) => setTimeout(r, TILE_THROTTLE_MS));
    }
    firstTile = false;

    const tileStartMs = Math.max(from.getTime(), tileEnd.getTime() - BACKFILL_TILE * 60000);
    const tileStart   = new Date(tileStartMs);
    const limit       = Math.round((tileEnd.getTime() - tileStartMs) / 60000);

    // Fan out per-venue pegFetcherRange for this tile. Fetch one extra minute
    // (limit+1): binance/bybit/bitget include the endTime minute and drop the
    // bottom of the window, so without the +1 every 300-min tile boundary loses
    // its first minute (the recurring :47 stable-rate hole). The [tileStartMs,
    // tileEnd) filter below trims the overlap; the upsert makes it idempotent.
    const settled = await Promise.allSettled(
      usdtSources.map((name) => {
        const a = ADAPTER_BY_NAME[name];
        return a.normalize.pegFetcherRange!(tileEnd, limit + 1);
      }),
    );

    for (let i = 0; i < usdtSources.length; i++) {
      const source = usdtSources[i];
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

  const result: BackfillStableRatesResult = { rowsInserted, rowsSkippedNoBtc, failedPerSource };
  if (clamped.from) result.clamped = clamped;
  log(`[stableRateBackfill] rowsInserted=${rowsInserted} rowsSkippedNoBtc=${rowsSkippedNoBtc} failures=${JSON.stringify(failedPerSource)}`);
  return result;
}
