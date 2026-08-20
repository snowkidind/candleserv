import type { SourceCandle, SourceResult } from "../types/index.js";
import { recordError } from "../db/errors.js";
import { logError, logWarn } from "./log.js";
import { SOURCE_BITS, ADAPTER_BY_NAME } from "../adapters/registry.js";

// Premium-offset correction tuning. Pulls each venue's contribution
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
 * Leave-one-out premium-offset correction for one field's values, returned in
 * the same order. Each value is pulled CORRECTION_FACTOR of the way toward the
 * median of its peers. This is the SAME correction buildComposite step 2 applies
 * to the close field (close is always corrected there); it is factored out so
 * the outlier guard can judge corrected closes without re-deriving the math.
 */
function correctByConsensus(values: number[]): number[] {
  return values.map((v, i) => {
    const consensus = median(values.filter((_, j) => j !== i));
    return v - CORRECTION_FACTOR * (v - consensus);
  });
}

/**
 * Apply input guards to a set of raw source candles.
 * Returns an array of GuardedSource (accepted + rejected).
 *
 * pegRates: optional Map<sourceName, localStableToUsdRate>. When provided, the
 *   outlier guard compares peg-normalized closes (USDT venues × rate; USD-native
 *   venues identity) rather than raw quotes. This is required for correctness:
 *   the composite itself is built in peg-normalized USD space (buildComposite),
 *   and historicalSigma is derived from composite closes — also USD space. Running
 *   the outlier check on RAW closes systematically rejects USD-native venues
 *   (kraken, coinbase) whenever USDT carries a premium larger than σ, even though
 *   they agree with the others once normalized. Absent map → raw comparison
 *   (cold-start / single-currency callers unchanged). The returned candle is
 *   always the RAW candle — only the outlier *decision* runs in normalized space.
 *
 * premiumEnabled: when true (and ≥ MIN_FOR_OFFSET_CORRECTION sources survive the
 *   zero/OHLC checks), the outlier decision also applies buildComposite's
 *   leave-one-out premium-offset correction to the normalized closes before the
 *   σ test. Peg normalization only neutralizes the USDT/USD quote basis; it does
 *   NOT remove a USD-native venue's structural cross-exchange premium (e.g.
 *   bitfinex, which has no peg → identity under normalization). Without this, a
 *   structurally-premiumed venue is rejected as an outlier before the very
 *   correction designed to absorb that premium runs in buildComposite. When false
 *   or fewer than 3 sources, the test judges the peg-normalized close unchanged.
 */
export function applyGuards(
  results: SourceResult[],
  minSources: number,
  historicalSigma?: number,
  pegRates?: Map<string, number>,
  premiumEnabled: boolean = true,
): GuardedSource[] {
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

  // Normalize the close into USD space for the outlier comparison. USDT venues
  // get multiplied by their peg rate; USD-native venues (absent from the map)
  // and the no-peg path are identity.
  const normClose = (g: GuardedSource): number => {
    const rate = pegRates?.get(g.source);
    return rate === undefined ? g.candle.close : g.candle.close * rate;
  };

  // Judge the premium-corrected normalized close, so a USD-native venue's
  // structural basis (which normalization leaves untouched) doesn't read as an
  // outlier. Falls back to the plain normalized close when correction is off or
  // the population is below the leave-one-out floor — i.e. the peg-normalized-
  // only behavior is preserved in those cases.
  const normalized = passed.map(normClose);
  const judged = premiumEnabled && passed.length >= MIN_FOR_OFFSET_CORRECTION
    ? correctByConsensus(normalized)
    : normalized;
  const judgedBySource = new Map<string, number>();
  passed.forEach((g, i) => judgedBySource.set(g.source, judged[i]));

  const med = median(judged);
  const sigma = historicalSigma ?? Math.max(stddev(judged), 10);

  return afterBasic.map((g) => {
    if (g.rejected) return g;
    const x = judgedBySource.get(g.source)!;
    if (Math.abs(x - med) > sigma) {
      const note = x === g.candle.close ? "" : ` (judged=${x.toFixed(2)})`;
      logError(`[composite] outlier rejected: ${g.source} close=${g.candle.close}${note} median=${med.toFixed(2)} σ=${sigma.toFixed(2)}`);
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
 * Pipeline:
 *   1. Peg-adjust each accepted source's candle.
 *   2. For each field (O,H,L,C) and each source, compute the leave-one-out
 *      median across the population (its "consensus") and pull the source's
 *      contribution toward consensus by CORRECTION_FACTOR × (value − consensus).
 *      Wicks may pass through uncorrected when the venue's profile sets
 *      applyOffsetToWicks=false (forward-looking for on-chain venues).
 *   3. The final composite OHLC are medians across the post-correction
 *      contributions — H/L come from the same population as O/C.
 *
 * premiumEnabled: per-currency toggle (currencies.premiumEnabled). When false,
 *   the leave-one-out premium-offset correction (step 2) is bypassed entirely
 *   and the composite OHLC are plain field-wise medians of the peg-adjusted
 *   values. The peg always applies regardless — only the cross-venue premium
 *   neutralization is gated. Defaults true so single-currency callers and the
 *   N<3 path are unchanged.
 */
export async function buildComposite(
  guarded: GuardedSource[],
  sourceCountBaseline: number,
  candleTs?: Date,
  pegRates?: Map<string, number>,
  premiumEnabled: boolean = true,
  currency?: string,   // for log attribution only — which asset this composite is for
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

  if (!premiumEnabled || pegged.length < MIN_FOR_OFFSET_CORRECTION) {
    // Plain field-wise medians of the peg-adjusted values. Two cases land here:
    //   (a) premiumEnabled=false — operator disabled premium correction for this
    //       currency; peg still applied above, only the cross-venue offset pull
    //       is skipped.
    //   (b) N<3 — leave-one-out median is undefined for fewer than 3 sources, so
    //       the correction can't run. composeMinute's minSources guard (default 3)
    //       usually prevents this live, but recompose-historical paths may
    //       produce smaller populations.
    open  = median(pegged.map((p) => p.candle.open));
    close = median(pegged.map((p) => p.candle.close));
    high  = median(pegged.map((p) => p.candle.high));
    low   = median(pegged.map((p) => p.candle.low));
    if (premiumEnabled && candleTs) {
      // Name the asset + which venues dropped (and why), so the line is
      // self-diagnosing — N is the accepted count; `failed` is everything the
      // guards rejected (fetch_failed = missing/no-candle, outlier, etc.).
      const acceptedNames = pegged.map((p) => p.source).join(",");
      const failed = guarded
        .filter((g) => g.rejected)
        .map((g) => `${g.source}:${g.rejectedReason ?? "rejected"}`)
        .join(",");
      logWarn(
        `[composite] ${currency ?? "?"} N=${pegged.length} < ${MIN_FOR_OFFSET_CORRECTION} at ${candleTs.toISOString()}; ` +
        `accepted=[${acceptedNames}] failed=[${failed || "none"}]; skipping premium-offset correction`,
      );
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
