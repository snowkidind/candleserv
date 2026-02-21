import type { SourceCandle } from "../types/index";

const BASE = "https://api.bybit.com";
const TIMEOUT_MS = 6000;

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
