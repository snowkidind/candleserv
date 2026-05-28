import type { SourceCandle } from "../types/index.js";

const BASE = "https://api.bybit.com";
const TIMEOUT_MS = 6000;

/**
 * Fetch up to 1000 1m candles ending before endTime (for backfill).
 * Returns rows sorted ascending by timestamp.
 */
export async function fetchBybitRange(symbol: string, endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const url = `${BASE}/v5/market/kline?symbol=${symbol}&interval=1&end=${endTime.getTime()}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
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
 * Bybit local USDT/USD rate. Live path reads bybit's computed usdIndexPrice
 * from the tickers endpoint (richer than the thin USDTUSD spot market;
 * fallback to lastPrice). The endpoint accepts no timestamp parameter —
 * minuteTs is ignored and the returned rate is effectively "now". Sub-bps
 * temporal skew within a single minute; do not engineer around it.
 *
 * See plan: candleserv-stablecoin-aware-index §Per-venue stable rates.
 */
export async function fetchBybitStableRate(_minuteTs: Date): Promise<number> {
  const url = `${BASE}/v5/market/tickers?category=spot&symbol=USDTUSD`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { result?: { list?: { usdIndexPrice?: string; lastPrice?: string }[] } };
    const row = json.result?.list?.[0];
    if (!row) throw new Error("No USDTUSD ticker returned");
    const raw = row.usdIndexPrice ?? row.lastPrice;
    if (!raw) throw new Error("No usdIndexPrice or lastPrice in USDTUSD ticker");
    return checkRateBound("bybit.USDTUSD", Number(raw));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Range backfill. Bybit's tickers endpoint has no historical mode, so we use
 * /v5/market/kline?symbol=USDTUSD&interval=1 close. This is the thin spot
 * market (~$400K liquidity) and produces a noisier rate series than the live
 * usdIndexPrice path — accepted asymmetry per plan §"Bybit live vs. backfill
 * asymmetry" (default resolution: (a) document and let the offset layer
 * absorb the extra noise).
 */
export async function fetchBybitStableRange(endTime: Date, limit: number): Promise<{ timestamp: Date; rate: number }[]> {
  const url = `${BASE}/v5/market/kline?category=spot&symbol=USDTUSD&interval=1&end=${endTime.getTime()}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { result?: { list?: unknown[][] } };
    const list = json.result?.list ?? [];
    return list
      .map((row) => ({
        timestamp: new Date(Number(row[0])),
        rate: checkRateBound("bybit.USDTUSD", Number(row[4])),
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBybitCandle(symbol: string, minuteTs: Date): Promise<SourceCandle> {
  const startTime = minuteTs.getTime();
  const endTime = startTime + 60000;
  const url = `${BASE}/v5/market/kline?symbol=${symbol}&interval=1&start=${startTime}&end=${endTime}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
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
