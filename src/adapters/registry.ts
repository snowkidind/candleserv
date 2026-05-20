import type { SourceCandle } from "../types/index.js";
import { fetchBinanceCandle, fetchBinanceRange } from "./binance.js";
import { fetchBybitCandle, fetchBybitRange } from "./bybit.js";
import { fetchKrakenCandle, fetchKrakenRange } from "./kraken.js";
import { fetchCoinbaseCandle, fetchCoinbaseRange } from "./coinbase.js";
import { fetchBitfinexCandle, fetchBitfinexRange } from "./bitfinex.js";
import { fetchOkxCandle, fetchOkxRange } from "./okx.js";
import { fetchGateCandle, fetchGateRange } from "./gate.js";
import { fetchBitgetCandle, fetchBitgetRange } from "./bitget.js";

export interface Adapter {
  name: string;
  bit: number;
  fetchOne: (ts: Date) => Promise<SourceCandle>;
  fetchRange: (endTime: Date, limit: number) => Promise<{ timestamp: Date; candle: SourceCandle }[]>;
}

// Bit numbers are part of the on-disk bitmask format and must remain stable forever.
// Only ever append to this list.
export const ADAPTERS: Adapter[] = [
  { name: "binance",  bit: 0, fetchOne: fetchBinanceCandle,  fetchRange: fetchBinanceRange  },
  { name: "bybit",    bit: 1, fetchOne: fetchBybitCandle,    fetchRange: fetchBybitRange    },
  { name: "kraken",   bit: 2, fetchOne: fetchKrakenCandle,   fetchRange: fetchKrakenRange   },
  { name: "coinbase", bit: 3, fetchOne: fetchCoinbaseCandle, fetchRange: fetchCoinbaseRange },
  { name: "bitfinex", bit: 4, fetchOne: fetchBitfinexCandle, fetchRange: fetchBitfinexRange },
  { name: "okx",      bit: 5, fetchOne: fetchOkxCandle,      fetchRange: fetchOkxRange      },
  { name: "gate",     bit: 6, fetchOne: fetchGateCandle,     fetchRange: fetchGateRange     },
  { name: "bitget",   bit: 7, fetchOne: fetchBitgetCandle,   fetchRange: fetchBitgetRange   },
];

export const SOURCE_NAMES: string[] = ADAPTERS.map((a) => a.name);

export const SOURCE_BITS: Record<string, number> = Object.fromEntries(
  ADAPTERS.map((a) => [a.name, 1 << a.bit]),
);

export const ADAPTER_BY_NAME: Record<string, Adapter> = Object.fromEntries(
  ADAPTERS.map((a) => [a.name, a]),
);
