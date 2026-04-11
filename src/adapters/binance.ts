import type { SourceCandle } from "../types/index.js";

const BASE = "https://api.binance.com";
const TIMEOUT_MS = 6000;

/**
 * Fetch a single 1m candle for a given UTC minute boundary.
 */
export async function fetchBinanceCandle(minuteTs: Date): Promise<SourceCandle> {
  const startTime = minuteTs.getTime();
  const endTime = startTime + 60000 - 1;
  const url = `${BASE}/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json() as unknown[][];

    // Binance occasionally returns empty at the daily UTC boundary (00:00).
    // Retry once after a short delay before giving up.
    if (!data.length) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const res2 = await fetch(url);
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      data = await res2.json() as unknown[][];
    }

    if (!data.length) throw new Error("No candle returned");
    const [, o, h, l, c, v] = data[0];
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

/**
 * Fetch up to 1000 1m candles ending at endTime (for backfill).
 */
export async function fetchBinanceRange(endTime: Date, limit = 1000): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const url = `${BASE}/api/v3/klines?symbol=BTCUSDT&interval=1m&endTime=${endTime.getTime()}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as unknown[][];
    return data.map((row) => ({
      timestamp: new Date(Number(row[0])),
      candle: {
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      },
    }));
  } finally {
    clearTimeout(timer);
  }
}
