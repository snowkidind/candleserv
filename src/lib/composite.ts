import type { SourceCandle, SourceResult } from "../types/index.js";
import { recordError } from "../db/errors.js";
import { logError, logWarn } from "./log.js";
import { SOURCE_BITS, ADAPTER_BY_NAME } from "../adapters/registry.js";

// Premium-offset correction tuning. See plan:
// candleserv-stablecoin-aware-index §Phase 3. Pulls each venue's contribution
// 80% of the way toward the leave-one-out consensus across its peers before
// the final median, tightening the population on the wick fields and
// neutralizing per-venue basis while preserving structural price moves.
const CORRECTION_FACTOR = 0.8;
const MIN_FOR_OFFSET_CORRECTION = 3;

type Field = "open" | "high" | "low" | "close";
const FIELDS: readonly Field[] = ["open", "high", "low", "close"] as const;

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
 *
 * pegRates: optional Map<sourceName, localStableToUsdRate>. When provided, each
 *   USDT venue's O/H/L/C is multiplied by its peg rate before any consensus
 *   computation — so the composite is in real-USD space rather than the raw
 *   mixed-quote space. Absent keys are identity (USD-native venues). Volume
 *   is NOT peg-adjusted — venue volumes are venue-denominated base-asset
 *   quantities and the peg only applies to price.
 *
 * Pipeline (per plan: candleserv-stablecoin-aware-index §Phase 3):
 *   1. Peg-adjust each accepted source's candle.
 *   2. For each field (O,H,L,C) and each source, compute the leave-one-out
 *      median across the population (its "consensus") and pull the source's
 *      contribution toward consensus by CORRECTION_FACTOR × (value − consensus).
 *      Wicks may pass through uncorrected when the venue's profile sets
 *      applyOffsetToWicks=false (forward-looking for on-chain venues).
 *   3. The final composite OHLC are medians across the post-correction
 *      contributions — H/L come from the same population as O/C, replacing
 *      the prior dominant-source-wick rule.
 */
export async function buildComposite(
  guarded: GuardedSource[],
  sourceCountBaseline: number,
  candleTs?: Date,
  pegRates?: Map<string, number>,
): Promise<CompositeResult> {
  const accepted = guarded.filter((g) => !g.rejected && g.candle);

  if (accepted.length === 0) {
    await recordError("composite", "buildComposite", "All sources rejected — no composite possible");
    throw new Error("No accepted sources");
  }

  // Step 1: peg-adjust each accepted source.
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

  let open: number, high: number, low: number, close: number;

  if (pegged.length < MIN_FOR_OFFSET_CORRECTION) {
    // Leave-one-out median is undefined for N<3 — peg-adjusted values pass
    // through unmodified. composeMinute's minSources guard (default 3) usually
    // prevents N<3 from reaching here in live operation, but recompose-historical
    // paths may produce smaller populations.
    open  = median(pegged.map((p) => p.candle.open));
    close = median(pegged.map((p) => p.candle.close));
    high  = median(pegged.map((p) => p.candle.high));
    low   = median(pegged.map((p) => p.candle.low));
    if (candleTs) {
      logWarn(`[composite] N=${pegged.length} < ${MIN_FOR_OFFSET_CORRECTION} at ${candleTs.toISOString()}; skipping premium-offset correction`);
    }
  } else {
    // Step 2: per-field leave-one-out consensus + CORRECTION_FACTOR pull.
    const contributions: Record<Field, number[]> = { open: [], high: [], low: [], close: [] };
    for (const field of FIELDS) {
      const values = pegged.map((p) => p.candle[field]);
      for (let i = 0; i < pegged.length; i++) {
        const others = values.filter((_, j) => j !== i);
        const consensus = median(others);
        const offset = values[i] - consensus;
        const profile = ADAPTER_BY_NAME[pegged[i].source]?.normalize;
        const applyCorrection = field === "open" || field === "close" || (profile?.applyOffsetToWicks ?? true);
        contributions[field].push(applyCorrection ? values[i] - CORRECTION_FACTOR * offset : values[i]);
      }
    }
    // Step 3: composite OHLC = field-wise medians of the post-correction population.
    open  = median(contributions.open);
    close = median(contributions.close);
    high  = median(contributions.high);
    low   = median(contributions.low);
  }

  // Independent per-field medians can in pathological minutes produce
  // high < max(open, close) or low > min(open, close). Widen to enclose the
  // body. Should be rare with median-of-population wicks but the defensive
  // guard is cheap.
  const bodyHigh = Math.max(open, close);
  const bodyLow  = Math.min(open, close);
  if (high < bodyHigh) high = bodyHigh;
  if (low  > bodyLow)  low  = bodyLow;

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
