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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    let data = await res.json() as unknown[][];

    // Binance occasionally returns empty at the daily UTC boundary (00:00).
    // Retry once after a short delay before giving up.
    if (!data.length) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const res2 = await fetch(url);
      if (!res2.ok) throw new Error(`HTTP ${res2.status} ${url} (retry)`);
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

// Local USDT/USD rate bounds — loose enough to admit historical extremes like
// USDT@0.85 in 2018, tight enough that hitting them means the upstream feed
// is broken. See plan: candleserv-stablecoin-aware-index §Phase 1
// "Sanity bounds on stable rate."
const STABLE_RATE_MIN = 0.50;
const STABLE_RATE_MAX = 1.50;

function checkRateBound(name: string, rate: number): number {
  if (!Number.isFinite(rate) || rate < STABLE_RATE_MIN || rate > STABLE_RATE_MAX) {
    throw new Error(`${name}: stable rate ${rate} outside sanity bounds [${STABLE_RATE_MIN}, ${STABLE_RATE_MAX}]`);
  }
  return rate;
}

/**
 * Fetch binance's local USDT/USD rate at the given minute boundary.
 * Derivation: rate = 1 / USDCUSDT close (USDC treated as $1). See plan §Phase 1.
 */
export async function fetchBinanceStableRate(minuteTs: Date): Promise<number> {
  const startTime = minuteTs.getTime();
  const endTime = startTime + 60000 - 1;
  const url = `${BASE}/api/v3/klines?symbol=USDCUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const data = await res.json() as unknown[][];
    if (!data.length) throw new Error("No USDCUSDT candle returned");
    const close = Number(data[0][4]);
    return checkRateBound("binance.USDCUSDT", 1 / close);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Range backfill: returns paired (timestamp, rate) rows ending at endTime.
 */
export async function fetchBinanceStableRange(endTime: Date, limit = 1000): Promise<{ timestamp: Date; rate: number }[]> {
  const url = `${BASE}/api/v3/klines?symbol=USDCUSDT&interval=1m&endTime=${endTime.getTime()}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const data = await res.json() as unknown[][];
    return data.map((row) => ({
      timestamp: new Date(Number(row[0])),
      rate: checkRateBound("binance.USDCUSDT", 1 / Number(row[4])),
    }));
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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
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
