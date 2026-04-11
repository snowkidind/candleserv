import type { SourceCandle } from "../types/index.js";

const BASE = "https://api.exchange.coinbase.com";
const TIMEOUT_MS = 6000;

const COINBASE_CHUNK = 300; // API hard limit per call

async function fetchCoinbaseChunk(startTime: Date, endTime: Date): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const start = startTime.toISOString().slice(0, 19) + "Z";
  const end   = endTime.toISOString().slice(0, 19) + "Z";
  const url = `${BASE}/products/BTC-USD/candles?granularity=60&start=${start}&end=${end}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    // Coinbase: [timestamp_unix_s, low, high, open, close, volume]
    return data.map((row) => ({
      timestamp: new Date(Number(row[0]) * 1000),
      candle: {
        open:   Number(row[3]),
        high:   Number(row[2]),
        low:    Number(row[1]),
        close:  Number(row[4]),
        volume: Number(row[5]),
      },
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch up to `limit` 1m candles ending before endTime.
 * Internally paginates in 300-candle chunks (Coinbase API limit).
 * Returns rows sorted ascending by timestamp.
 */
export async function fetchCoinbaseRange(endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const allResults: { timestamp: Date; candle: SourceCandle }[] = [];
  let remaining = limit;
  let chunkEnd = endTime;

  while (remaining > 0) {
    const chunkSize  = Math.min(remaining, COINBASE_CHUNK);
    const chunkStart = new Date(chunkEnd.getTime() - chunkSize * 60000);
    const rows = await fetchCoinbaseChunk(chunkStart, chunkEnd);
    allResults.push(...rows);
    remaining -= chunkSize;
    chunkEnd   = chunkStart;
  }

  return allResults.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export async function fetchCoinbaseCandle(minuteTs: Date): Promise<SourceCandle> {
  const start = minuteTs.toISOString().slice(0, 19) + "Z";
  const end = new Date(minuteTs.getTime() + 60000).toISOString().slice(0, 19) + "Z";
  const url = `${BASE}/products/BTC-USD/candles?granularity=60&start=${start}&end=${end}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    if (!data.length) throw new Error("No candle returned");

    // Coinbase: [timestamp_unix, low, high, open, close, volume]
    const row = data[0];
    return {
      open: Number(row[3]),
      high: Number(row[2]),
      low: Number(row[1]),
      close: Number(row[4]),
      volume: Number(row[5]),
    };
  } finally {
    clearTimeout(timer);
  }
}
