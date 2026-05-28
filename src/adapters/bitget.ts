/**
 * Bitget adapter — BTC/USDT 1m spot candles.
 *
 * Endpoint: GET https://api.bitget.com/api/v2/spot/market/candles
 * Pair name: BTCUSDT (no separator).
 * Timestamps: milliseconds.
 * Rate limit: 20 req / s / IP.
 * Response envelope: { code, msg, data: [[ts, o, h, l, c, volBase, volQuote, ...], ...] }
 * Row order is standard OHLCV with volBase at index 5 (BTC volume).
 */
import type { SourceCandle } from "../types/index.js";

const BASE = "https://api.bitget.com";
const TIMEOUT_MS = 6000;
const RANGE_TIMEOUT_MS = 30000;

function parseRow(row: unknown[]): { timestamp: Date; candle: SourceCandle } {
  return {
    timestamp: new Date(Number(row[0])),
    candle: {
      open:   Number(row[1]),
      high:   Number(row[2]),
      low:    Number(row[3]),
      close:  Number(row[4]),
      volume: Number(row[5]),
    },
  };
}

// Local stable-rate sanity bounds. See plan: candleserv-stablecoin-aware-index
// §Phase 1 "Sanity bounds on stable rate."
const STABLE_RATE_MIN = 0.50;
const STABLE_RATE_MAX = 1.50;

function checkRateBound(name: string, rate: number): number {
  if (!Number.isFinite(rate) || rate < STABLE_RATE_MIN || rate > STABLE_RATE_MAX) {
    throw new Error(`${name}: stable rate ${rate} outside sanity bounds [${STABLE_RATE_MIN}, ${STABLE_RATE_MAX}]`);
  }
  return rate;
}

/**
 * Bitget local USDT/USD rate. Derivation: rate = 1 / USDCUSDT close (USDC ≈ $1).
 * See plan §Per-venue stable rates.
 */
export async function fetchBitgetStableRate(minuteTs: Date): Promise<number> {
  const startTime = minuteTs.getTime();
  const endTime   = startTime + 60000;
  const url = `${BASE}/api/v2/spot/market/candles?symbol=USDCUSDT&granularity=1min&startTime=${startTime}&endTime=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { data?: unknown[][]; code?: string; msg?: string };
    if (json.code && json.code !== "00000") throw new Error(`Bitget ${json.code}: ${json.msg ?? "error"}`);
    const data = json.data ?? [];
    if (!data.length) throw new Error("No USDCUSDT candle returned");
    const close = Number(data[0][4]);
    return checkRateBound("bitget.USDCUSDT", 1 / close);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Range backfill — same shape as fetchBitgetRange but reads USDCUSDT.
 */
export async function fetchBitgetStableRange(endTime: Date, limit: number): Promise<{ timestamp: Date; rate: number }[]> {
  const endMs   = endTime.getTime();
  const want    = Math.min(limit, 1000);
  const startMs = endMs - want * 60000;
  const url = `${BASE}/api/v2/spot/market/candles?symbol=USDCUSDT&granularity=1min&startTime=${startMs}&endTime=${endMs}&limit=${want}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { data?: unknown[][]; code?: string; msg?: string };
    if (json.code && json.code !== "00000") throw new Error(`Bitget ${json.code}: ${json.msg ?? "error"}`);
    const data = json.data ?? [];
    return data
      .map((row) => ({
        timestamp: new Date(Number(row[0])),
        rate: checkRateBound("bitget.USDCUSDT", 1 / Number(row[4])),
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBitgetCandle(symbol: string, minuteTs: Date): Promise<SourceCandle> {
  const startTime = minuteTs.getTime();
  const endTime   = startTime + 60000;
  const url = `${BASE}/api/v2/spot/market/candles?symbol=${symbol}&granularity=1min&startTime=${startTime}&endTime=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { data?: unknown[][]; code?: string; msg?: string };
    if (json.code && json.code !== "00000") throw new Error(`Bitget ${json.code}: ${json.msg ?? "error"}`);
    const data = json.data ?? [];
    if (!data.length) throw new Error("No candle returned");
    return parseRow(data[0]).candle;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBitgetRange(symbol: string, endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const endMs   = endTime.getTime();
  const want    = Math.min(limit, 1000);
  const startMs = endMs - want * 60000;
  const url = `${BASE}/api/v2/spot/market/candles?symbol=${symbol}&granularity=1min&startTime=${startMs}&endTime=${endMs}&limit=${want}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { data?: unknown[][]; code?: string; msg?: string };
    if (json.code && json.code !== "00000") throw new Error(`Bitget ${json.code}: ${json.msg ?? "error"}`);
    const data = json.data ?? [];
    return data
      .map(parseRow)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}
