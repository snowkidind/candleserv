import type { SourceCandle } from "../types/index.js";

const BASE = "https://api-pub.bitfinex.com";
const TIMEOUT_MS = 6000;

/**
 * Fetch up to `limit` 1m candles ending before endTime (for backfill).
 * Returns rows sorted ascending by timestamp (sort=1).
 */
export async function fetchBitfinexRange(endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const startMs = endTime.getTime() - limit * 60000;
  const url = `${BASE}/v2/candles/trade:1m:tBTCUSD/hist?start=${startMs}&end=${endTime.getTime()}&limit=${limit}&sort=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    // Bitfinex: [mts, open, close, high, low, volume]
    return data.map((row) => ({
      timestamp: new Date(Number(row[0])),
      candle: {
        open:   Number(row[1]),
        high:   Number(row[3]),
        low:    Number(row[4]),
        close:  Number(row[2]),
        volume: Number(row[5]),
      },
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBitfinexCandle(minuteTs: Date): Promise<SourceCandle> {
  const start = minuteTs.getTime();
  const end = start + 60000;
  const url = `${BASE}/v2/candles/trade:1m:tBTCUSD/hist?start=${start}&end=${end}&limit=1&sort=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    if (!data.length) throw new Error("No candle returned");

    // Bitfinex: [mts, open, close, high, low, volume]
    const [, o, c, h, l, v] = data[0];
    return {
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
    };
  } finally {
    clearTimeout(timer);
  }
}
