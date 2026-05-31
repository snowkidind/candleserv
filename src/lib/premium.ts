/**
 * Premium-offset derivation (research/methods #12 — "Premium Offset as
 * Publishable Cross-Exchange Basis Index").
 *
 * The per-venue, per-field, per-minute premium offset is the signed dollar
 * deviation of a venue's peg-adjusted price from the leave-one-out consensus of
 * its peers:
 *
 *     peg_adjusted[v][f]   = raw[v][f] × local_stable_rate[v]   (USD-native: identity)
 *     consensus[v][f]      = median( peg_adjusted[j][f] : j ≠ v )
 *     premium_offset[v][f] = peg_adjusted[v][f] − consensus[v][f]   (signed USD)
 *
 * This is exactly the intermediate `buildComposite` (src/lib/composite.ts)
 * computes to pull each venue toward consensus before the final median, then
 * discards. It is never persisted — but it is fully re-derivable from the
 * archived per-source candles + paired stable rates, which is what this module
 * does. The bitfinex slice is the headline signal (USD_NATIVE venue, no peg →
 * its entire basis lands here as a venue/tether-stress observable).
 *
 * Faithful to the engine:
 *   - Accepted set mirrors composeMinute: rejected rows dropped, and a USDT
 *     venue with no paired rate row is dropped (the `missing_paired_rate`
 *     invariant — it never contributed to the composite, so it has no offset).
 *   - Offsets are only defined for minutes with ≥ MIN_FOR_OFFSET_CORRECTION
 *     accepted venues (below that buildComposite skips the offset stage).
 *
 * The published premium offset is the raw `pegged − consensus` for every field,
 * independent of the engine's CORRECTION_FACTOR pull and the per-venue
 * applyOffsetToWicks gate — those shape the composite, not the measurement.
 */
import type { SourceCandleRow } from "../db/candles.js";
import { ADAPTER_BY_NAME } from "../adapters/registry.js";

// Mirror of composite.ts — below 3 accepted venues the leave-one-out median is
// undefined and buildComposite skips the offset stage, so no offset exists.
const MIN_FOR_OFFSET_CORRECTION = 3;

type Field = "o" | "h" | "l" | "c";
const FIELDS: readonly Field[] = ["o", "h", "l", "c"] as const;

/** USDT-quoted venues (those carrying a pegFetcher) — need a paired rate to count. */
const PEG_VENUES: Set<string> = new Set(
  Object.values(ADAPTER_BY_NAME)
    .filter((a) => a.normalize.pegFetcher != null)
    .map((a) => a.name),
);

/** True for a USDT-quoted venue (peg-corrected); false for USD-native. */
export function isPegVenue(source: string): boolean {
  return PEG_VENUES.has(source);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** A per-minute premium offset (signed USD) for one venue, all four fields. */
export interface MinuteOffset {
  t: number; // unix ms, bar open
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Compute per-venue per-minute premium offsets from archived source rows.
 * Returns a map: venue → ascending array of MinuteOffset. Minutes with fewer
 * than MIN_FOR_OFFSET_CORRECTION accepted venues contribute no offsets.
 *
 * `rows` is the output of getSourceCandles (ascending by minute then source);
 * `t` there is unix SECONDS.
 */
export function computeMinuteOffsets(rows: SourceCandleRow[]): Map<string, MinuteOffset[]> {
  // Bucket rows by minute (seconds key preserves ordering).
  const byMinute = new Map<number, SourceCandleRow[]>();
  for (const r of rows) {
    let bucket = byMinute.get(r.t);
    if (!bucket) { bucket = []; byMinute.set(r.t, bucket); }
    bucket.push(r);
  }

  const out = new Map<string, MinuteOffset[]>();
  const minutes = [...byMinute.keys()].sort((a, b) => a - b);

  for (const minute of minutes) {
    const raw = byMinute.get(minute)!;

    // Accepted set — mirror composeMinute: drop rejected rows, and drop a USDT
    // venue lacking its paired rate (it never contributed to the composite).
    const accepted = raw.filter(
      (r) => !r.rejected && !(PEG_VENUES.has(r.source) && r.peg == null),
    );
    if (accepted.length < MIN_FOR_OFFSET_CORRECTION) continue;

    // Peg-adjust each field into real-USD space (USD-native venues: identity).
    const pegged = accepted.map((r) => {
      const rate = PEG_VENUES.has(r.source) && r.peg != null ? r.peg : 1;
      return { source: r.source, o: r.o * rate, h: r.h * rate, l: r.l * rate, c: r.c * rate };
    });

    const tMs = minute * 1000;
    // o-pass appends this minute's entry for each venue; h/l/c passes fill the
    // entry just appended (the venue's last, since minutes run in order).
    for (const field of FIELDS) {
      const values = pegged.map((p) => p[field]);
      for (let i = 0; i < pegged.length; i++) {
        const others = values.filter((_, j) => j !== i);
        const offset = values[i] - median(others);
        const src = pegged[i].source;
        if (field === "o") {
          let series = out.get(src);
          if (!series) { series = []; out.set(src, series); }
          series.push({ t: tMs, o: offset, h: 0, l: 0, c: 0 });
        } else {
          const series = out.get(src)!;
          series[series.length - 1][field] = offset;
        }
      }
    }
  }
  return out;
}

/** An OHLC-of-offset bucket: the premium basis aggregated up to a timeframe. */
export interface PremiumBar {
  t: number; // unix ms, bucket open
  o: number; // offset at the first minute of the bucket
  h: number; // widest the basis got (max high-field offset across the bucket)
  l: number; // narrowest (min low-field offset)
  c: number; // offset at the last minute of the bucket
  n: number; // minutes that contributed
}

/**
 * Aggregate a venue's per-minute offsets into OHLC-of-offset bars at the given
 * timeframe:
 *   open  = open-field offset at the bucket's first minute
 *   close = close-field offset at the bucket's last minute
 *   high  = the widest the basis got anywhere in the bucket (max over all four
 *           field offsets across all minutes)
 *   low   = the narrowest (min over all field offsets across all minutes)
 * This is the "OHLC of the basis" from the bitfinex-premium study (Finding 6):
 * the wick captures intraday basis excursions that closes hide. Because high/low
 * range over every field offset (open/close included), the wick always encloses
 * the body. Returns ascending bars, trimmed to the most recent `limit`.
 */
export function aggregateOffsets(series: MinuteOffset[], tfMinutes: number, limit: number): PremiumBar[] {
  if (series.length === 0) return [];
  const bucketSec = tfMinutes * 60;
  const buckets = new Map<number, PremiumBar>();

  for (const m of series) {
    const sec = Math.floor(m.t / 1000);
    const bucketStart = Math.floor(sec / bucketSec) * bucketSec * 1000;
    const hi = Math.max(m.o, m.h, m.l, m.c);
    const lo = Math.min(m.o, m.h, m.l, m.c);
    const bar = buckets.get(bucketStart);
    if (!bar) {
      buckets.set(bucketStart, { t: bucketStart, o: m.o, h: hi, l: lo, c: m.c, n: 1 });
    } else {
      // series is ascending, so close is always the latest seen.
      bar.c = m.c;
      if (hi > bar.h) bar.h = hi;
      if (lo < bar.l) bar.l = lo;
      bar.n += 1;
    }
  }

  const round = (x: number) => Number(x.toFixed(4));
  const bars = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({ t: b.t, o: round(b.o), h: round(b.h), l: round(b.l), c: round(b.c), n: b.n }));
  return bars.length > limit ? bars.slice(bars.length - limit) : bars;
}
