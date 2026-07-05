import type { SourceCandle } from "../types/index.js";
import { venueGate } from "../lib/rateLimit.js";
import {
  fetchBinanceCandle, fetchBinanceRange,
  fetchBinanceStableRate, fetchBinanceStableRange,
} from "./binance.js";
import {
  fetchBybitCandle, fetchBybitRange,
  fetchBybitStableRate, fetchBybitStableRange,
} from "./bybit.js";
import { fetchKrakenCandle, fetchKrakenRange } from "./kraken.js";
import { fetchCoinbaseCandle, fetchCoinbaseRange } from "./coinbase.js";
import { fetchBitfinexCandle, fetchBitfinexRange } from "./bitfinex.js";
import { fetchOkxCandle, fetchOkxRange } from "./okx.js";
import {
  fetchGateCandle, fetchGateRange,
  fetchGateStableRate, fetchGateStableRange,
} from "./gate.js";
import {
  fetchBitgetCandle, fetchBitgetRange,
  fetchBitgetStableRate, fetchBitgetStableRange,
} from "./bitget.js";

/**
 * Per-venue normalization profile. See plan:
 * candleserv-stablecoin-aware-index §Per-source normalization profile.
 *
 * The peg fetcher is attached directly to the adapter (rather than a separate
 * stable-adapter registry) so the BTC quote and the local stable rate are a
 * single typed bundle — either both succeed for the minute or neither does.
 */
export interface NormalizationProfile {
  // Returns the local stable→USD rate for the given minute boundary. Throws on
  // failure — failure bundles with BTC fetch failure in the collector.
  // null = identity (USD-native venue; no peg adjustment).
  pegFetcher: ((ts: Date) => Promise<number>) | null;
  // Range backfill, mirroring the BTC fetchRange interface. null when pegFetcher is null.
  pegFetcherRange: ((endTime: Date, limit: number) => Promise<{ timestamp: Date; rate: number }[]>) | null;
  // Provenance — recorded on every stable_rates_1m_sources row. null when pegFetcher is null.
  pegSourcePair: string | null;
  // true: premium offset correction applies to O/H/L/C
  // false: correction applies only to O/C (wicks preserved)
  applyOffsetToWicks: boolean;
}

export interface Adapter {
  name: string;
  bit: number;
  fetchOne: (symbol: string, ts: Date) => Promise<SourceCandle>;
  fetchRange: (symbol: string, endTime: Date, limit: number) => Promise<{ timestamp: Date; candle: SourceCandle }[]>;
  normalize: NormalizationProfile;
}

const USD_NATIVE: NormalizationProfile = {
  pegFetcher: null,
  pegFetcherRange: null,
  pegSourcePair: null,
  applyOffsetToWicks: true,
};

// Bit numbers are part of the on-disk bitmask format and must remain stable forever.
// Only ever append to this list.
export const ADAPTERS: Adapter[] = [
  {
    name: "binance",  bit: 0,
    fetchOne: fetchBinanceCandle,  fetchRange: fetchBinanceRange,
    normalize: {
      pegFetcher: fetchBinanceStableRate,
      pegFetcherRange: fetchBinanceStableRange,
      pegSourcePair: "USDCUSDT",
      applyOffsetToWicks: true,
    },
  },
  {
    name: "bybit",    bit: 1,
    fetchOne: fetchBybitCandle,    fetchRange: fetchBybitRange,
    normalize: {
      pegFetcher: fetchBybitStableRate,
      pegFetcherRange: fetchBybitStableRange,
      pegSourcePair: "USDTUSD",
      applyOffsetToWicks: true,
    },
  },
  { name: "kraken",   bit: 2, fetchOne: fetchKrakenCandle,   fetchRange: fetchKrakenRange,   normalize: USD_NATIVE },
  { name: "coinbase", bit: 3, fetchOne: fetchCoinbaseCandle, fetchRange: fetchCoinbaseRange, normalize: USD_NATIVE },
  { name: "bitfinex", bit: 4, fetchOne: fetchBitfinexCandle, fetchRange: fetchBitfinexRange, normalize: USD_NATIVE },
  { name: "okx",      bit: 5, fetchOne: fetchOkxCandle,      fetchRange: fetchOkxRange,      normalize: USD_NATIVE },
  {
    name: "gate",     bit: 6,
    fetchOne: fetchGateCandle,     fetchRange: fetchGateRange,
    normalize: {
      pegFetcher: fetchGateStableRate,
      pegFetcherRange: fetchGateStableRange,
      pegSourcePair: "USDC_USDT",
      applyOffsetToWicks: true,
    },
  },
  {
    name: "bitget",   bit: 7,
    fetchOne: fetchBitgetCandle,   fetchRange: fetchBitgetRange,
    normalize: {
      pegFetcher: fetchBitgetStableRate,
      pegFetcherRange: fetchBitgetStableRange,
      pegSourcePair: "USDCUSDT",
      applyOffsetToWicks: true,
    },
  },
];

// Wrap every adapter call (live collector, peg wave, backfill, repair, probe)
// in the per-venue rate gate so concurrent same-venue requests across
// currencies and code paths can't burst a venue past its per-IP limit. Venues
// with no configured interval (all but kraken) no-op. Done once here so no call
// site has to remember to gate. Each `a` is a fresh per-iteration binding.
for (const a of ADAPTERS) {
  const fetchOne = a.fetchOne;
  const fetchRange = a.fetchRange;
  a.fetchOne   = async (symbol, ts)            => { await venueGate(a.name); return fetchOne(symbol, ts); };
  a.fetchRange = async (symbol, endTime, limit) => { await venueGate(a.name); return fetchRange(symbol, endTime, limit); };
  const pf = a.normalize.pegFetcher;
  if (pf) a.normalize.pegFetcher = async (ts) => { await venueGate(a.name); return pf(ts); };
  const pfr = a.normalize.pegFetcherRange;
  if (pfr) a.normalize.pegFetcherRange = async (endTime, limit) => { await venueGate(a.name); return pfr(endTime, limit); };
}

export const SOURCE_NAMES: string[] = ADAPTERS.map((a) => a.name);

// The venues that carry a peg rate (normalize.pegFetcher != null): the only
// sources present in stable_rates_1m_sources. Evaluates to
// ["binance","bybit","gate","bitget"] in bit order. Read-only surface for the
// peg endpoints (routes/v1/peg.ts).
export const PEG_SOURCE_NAMES: string[] = ADAPTERS.filter((a) => a.normalize.pegFetcher != null).map((a) => a.name);

// Provenance: which ticker pair each peg venue derives its USDT→USD rate from.
// Evaluates to { binance:"USDCUSDT", bybit:"USDTUSD", gate:"USDC_USDT", bitget:"USDCUSDT" }.
export const PEG_SOURCE_PAIRS: Record<string, string> = Object.fromEntries(
  ADAPTERS.filter((a) => a.normalize.pegFetcher != null).map((a) => [a.name, a.normalize.pegSourcePair as string]),
);

export const SOURCE_BITS: Record<string, number> = Object.fromEntries(
  ADAPTERS.map((a) => [a.name, 1 << a.bit]),
);

export const ADAPTER_BY_NAME: Record<string, Adapter> = Object.fromEntries(
  ADAPTERS.map((a) => [a.name, a]),
);
