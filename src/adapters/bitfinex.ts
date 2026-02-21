import type { SourceCandle } from "../types/index";

const BASE = "https://api-pub.bitfinex.com";
const TIMEOUT_MS = 6000;

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
