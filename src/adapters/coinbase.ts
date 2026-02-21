import type { SourceCandle } from "../types/index";

const BASE = "https://api.exchange.coinbase.com";
const TIMEOUT_MS = 6000;

export async function fetchCoinbaseCandle(minuteTs: Date): Promise<SourceCandle> {
  const start = minuteTs.toISOString();
  const end = new Date(minuteTs.getTime() + 60000).toISOString();
  const url = `${BASE}/products/BTC-USDC/candles?granularity=60&start=${start}&end=${end}`;

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
