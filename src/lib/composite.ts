import type { SourceCandle, SourceResult } from "../types/index.js";
import { recordError } from "../db/errors.js";
import { logError } from "./log.js";
import { SOURCE_BITS } from "../adapters/registry.js";

export interface GuardedSource {
  source: string;
  candle: SourceCandle;
  rejected: boolean;
  rejectedReason: string | null;
}

export interface CompositeResult {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volumeNormalized: number;
  sourceCount: number;
  sourceCountBaseline: number;
  sources: number;         // bitmask
  confidence: number;
  guarded: GuardedSource[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddev(values: number[]): number {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length);
}

/**
 * Apply input guards to a set of raw source candles.
 * Returns an array of GuardedSource (accepted + rejected).
 */
export function applyGuards(results: SourceResult[], minSources: number, historicalSigma?: number): GuardedSource[] {
  // Step 1a + 1b: zero guard + OHLC consistency
  const afterBasic: GuardedSource[] = results.map(({ source, candle }) => {
    if (!candle) return { source, candle: candle as unknown as SourceCandle, rejected: true, rejectedReason: "fetch_failed" };

    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      return { source, candle, rejected: true, rejectedReason: "zero_value" };
    }
    if (
      candle.low > candle.open || candle.low > candle.close || candle.low > candle.high ||
      candle.high < candle.open || candle.high < candle.close
    ) {
      return { source, candle, rejected: true, rejectedReason: "ohlc_invalid" };
    }
    return { source, candle, rejected: false, rejectedReason: null };
  });

  const passed = afterBasic.filter((g) => !g.rejected);

  // Step 1c: outlier guard — only if we have enough sources
  if (passed.length < minSources) return afterBasic;

  const closes = passed.map((g) => g.candle.close);
  const med = median(closes);
  const sigma = historicalSigma ?? Math.max(stddev(closes), 10);

  return afterBasic.map((g) => {
    if (g.rejected) return g;
    if (Math.abs(g.candle.close - med) > sigma) {
      logError(`[composite] outlier rejected: ${g.source} close=${g.candle.close} median=${med} σ=${sigma.toFixed(2)}`);
      return { ...g, rejected: true, rejectedReason: "outlier" };
    }
    return g;
  });
}

/**
 * Build the composite candle from guarded sources.
 * dominantSource: name of the trailing volume leader (from getTrailingVolumeLeader).
 * If omitted or not present in accepted sources, falls back to the highest-volume
 * source in the current minute.
 *
 * pegRates: optional Map<sourceName, localStableToUsdRate>. When provided, each
 *   USDT venue's O/H/L/C is multiplied by its peg rate before median + dominant
 *   wick selection — so the composite is in real-USD space rather than the
 *   raw mixed-quote space. Absent keys are identity (USD-native venues).
 *   Volume is NOT peg-adjusted — venue volumes are venue-denominated base-asset
 *   quantities and the peg only applies to price.
 *   See plan: candleserv-stablecoin-aware-index §Phase 2.
 */
export async function buildComposite(
  guarded: GuardedSource[],
  sourceCountBaseline: number,
  dominantSource?: string,
  candleTs?: Date,
  pegRates?: Map<string, number>,
): Promise<CompositeResult> {
  const accepted = guarded.filter((g) => !g.rejected && g.candle);

  if (accepted.length === 0) {
    await recordError("composite", "buildComposite", "All sources rejected — no composite possible");
    throw new Error("No accepted sources");
  }

  // Peg-adjusted view of each accepted source. For USD-native venues (no peg
  // entry) the pegged candle is identical to the raw candle. Volume passes
  // through unchanged — peg only affects price.
  const pegged = accepted.map((g) => {
    const rate = pegRates?.get(g.source);
    if (rate === undefined) {
      return { source: g.source, candle: g.candle };
    }
    return {
      source: g.source,
      candle: {
        open:   g.candle.open   * rate,
        high:   g.candle.high   * rate,
        low:    g.candle.low    * rate,
        close:  g.candle.close  * rate,
        volume: g.candle.volume,
      },
    };
  });

  const closes = pegged.map((g) => g.candle.close);
  const opens  = pegged.map((g) => g.candle.open);

  const close  = median(closes);
  const open   = median(opens);

  // Use the trailing volume leader as the dominant H/L source.
  // Falls back to the highest-volume source in the current minute if the leader
  // isn't in the accepted set (e.g. it was rejected or absent this tick).
  const dominant = (dominantSource ? pegged.find(g => g.source === dominantSource) : null)
    ?? pegged.reduce((best, g) => g.candle.volume > best.candle.volume ? g : best, pegged[0]);

  // Continuity check: log if the dominant's H/L needs expanding to contain the body.
  // Under the peg layer the dominant's wick is in the same number space as the
  // body, so this should fire <0.1% of the time post-Phase 2 (vs ~100% pre-Phase 2
  // when USDT/USD drift was sliding USDT venues away from USD venues every minute).
  const bodyHigh = Math.max(open, close);
  const bodyLow  = Math.min(open, close);
  if (dominant.candle.high < bodyHigh || dominant.candle.low > bodyLow) {
    const tsLabel = candleTs ? ` candle=${candleTs.toISOString().slice(0, 16)}` : "";
    logError(
      `[composite] H/L extended for OHLC consistency:${tsLabel} sources=${accepted.length}/${sourceCountBaseline} dominant=${dominant.source} ` +
      `wick=[${dominant.candle.low.toFixed(2)}, ${dominant.candle.high.toFixed(2)}] ` +
      `body=[${bodyLow.toFixed(2)}, ${bodyHigh.toFixed(2)}]`
    );
  }
  const high = Math.max(dominant.candle.high, bodyHigh);
  const low  = Math.min(dominant.candle.low,  bodyLow);
  // Volume stays raw — peg adjustment applies to price only.
  const volume = accepted.reduce((sum, g) => sum + g.candle.volume, 0);

  const sourceCount = accepted.length;
  const volumeNormalized = volume * (sourceCountBaseline / sourceCount);

  let sourcesBitmask = 0;
  for (const g of accepted) {
    sourcesBitmask |= SOURCE_BITS[g.source] ?? 0;
  }

  const sourcesAttempted = guarded.length;
  const rejectedCount = guarded.filter((g) => g.rejected).length;
  const sourceRatio = sourceCount / sourceCountBaseline;
  const rejectedRatio = sourcesAttempted > 0 ? rejectedCount / sourcesAttempted : 0;
  const confidence = Math.max(0, Math.min(1, sourceRatio * (1 - rejectedRatio)));

  if (sourceCount === 1) {
    await recordError(
      "composite", "buildComposite",
      `Degraded composite: only 1 source accepted at this minute`
    );
  }

  return {
    open, high, low, close, volume, volumeNormalized,
    sourceCount, sourceCountBaseline,
    sources: sourcesBitmask,
    confidence,
    guarded,
  };
}
