import type { SourceCandle } from "../types/index";

const BASE = "https://api.bybit.com";
const TIMEOUT_MS = 6000;

/**
 * Fetch up to 1000 1m candles ending before endTime (for backfill).
 * Returns rows sorted ascending by timestamp.
 */
export async function fetchBybitRange(endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const url = `${BASE}/v5/market/kline?symbol=BTCUSDT&interval=1&end=${endTime.getTime()}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { result?: { list?: unknown[][] } };
    const list = json.result?.list ?? [];
    return list
      .map((row) => ({
        timestamp: new Date(Number(row[0])),
        candle: {
          open:   Number(row[1]),
          high:   Number(row[2]),
          low:    Number(row[3]),
          close:  Number(row[4]),
          volume: Number(row[5]),
        },
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBybitCandle(minuteTs: Date): Promise<SourceCandle> {
  const startTime = minuteTs.getTime();
  const endTime = startTime + 60000;
  const url = `${BASE}/v5/market/kline?symbol=BTCUSDT&interval=1&start=${startTime}&end=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { result?: { list?: unknown[][] } };
    const list = json.result?.list;
    if (!list?.length) throw new Error("No candle returned");
    // Bybit returns [startTime, open, high, low, close, volume, turnover]
    const [, o, h, l, c, v] = list[0];
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
