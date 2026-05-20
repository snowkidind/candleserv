/**
 * Gate.io adapter — BTC/USDT 1m spot candles.
 *
 * Endpoint: GET https://api.gateio.ws/api/v4/spot/candlesticks
 * Pair name: BTC_USDT (UNDERSCORE-separated — different from every other adapter).
 * Timestamps: UNIX SECONDS (not ms — different from every other adapter).
 * Rate limit: 900 req / min.
 *
 * Row order is NOT OHLCV — it's:
 *   [ts (string), vol_quote, close, high, low, open, vol_base, ...]
 * `vol_quote` is USDT volume; `vol_base` is BTC volume. To match the rest of
 * the system (volume in base currency), we read vol_base from index 6.
 *
 * The response is a JSON array of arrays (no envelope).
 */
import type { SourceCandle } from "../types/index.js";

const BASE = "https://api.gateio.ws";
const TIMEOUT_MS = 6000;
const RANGE_TIMEOUT_MS = 30000;

function parseRow(row: unknown[]): { timestamp: Date; candle: SourceCandle } {
  // row: [ts_str, vol_quote, close, high, low, open, vol_base, ...]
  const tsSec = Number(row[0]);
  return {
    timestamp: new Date(tsSec * 1000),
    candle: {
      open:   Number(row[5]),
      high:   Number(row[3]),
      low:    Number(row[4]),
      close:  Number(row[2]),
      volume: Number(row[6]),
    },
  };
}

export async function fetchGateCandle(minuteTs: Date): Promise<SourceCandle> {
  const fromSec = Math.floor(minuteTs.getTime() / 1000);
  const toSec   = fromSec + 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1m&from=${fromSec}&to=${toSec}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data) || !data.length) throw new Error("No candle returned");
    return parseRow(data[0]).candle;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGateRange(endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const toSec   = Math.floor(endTime.getTime() / 1000);
  const fromSec = toSec - Math.min(limit, 1000) * 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1m&from=${fromSec}&to=${toSec}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data)) throw new Error("Unexpected response shape");
    return data
      .map(parseRow)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}
