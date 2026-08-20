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
import { OutOfHistoryError, EmptyCandleError } from "./errors.js";

const BASE = "https://api.gateio.ws";
const TIMEOUT_MS = 6000;
const RANGE_TIMEOUT_MS = 30000;

// Gate caps historical 1m candles at 10,000 points (~6.9 days) and returns
// HTTP 400 with label "INVALID_PARAM_VALUE" + message "Candlestick too long
// ago…" when asked for older data. Distinct from a real failure.
async function throwIfNotOk(res: Response, url: string): Promise<void> {
  if (res.ok) return;
  const body = await res.clone().text().catch(() => "");
  if (res.status === 400 && body) {
    let parsed: { label?: string; message?: string } | null = null;
    try { parsed = JSON.parse(body) as { label?: string; message?: string }; } catch { /* not JSON; fall through to generic throw */ }
    if (parsed?.label === "INVALID_PARAM_VALUE" && /too long ago/i.test(parsed.message ?? "")) {
      throw new OutOfHistoryError("gate", parsed.message ?? "Candlestick too long ago");
    }
  }
  throw new Error(`HTTP ${res.status} ${url}${body ? ` body=${body.slice(0, 300)}` : ""}`);
}

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

// Local stable-rate sanity bounds.
const STABLE_RATE_MIN = 0.50;
const STABLE_RATE_MAX = 1.50;

function checkRateBound(name: string, rate: number): number {
  if (!Number.isFinite(rate) || rate < STABLE_RATE_MIN || rate > STABLE_RATE_MAX) {
    throw new Error(`${name}: stable rate ${rate} outside sanity bounds [${STABLE_RATE_MIN}, ${STABLE_RATE_MAX}]`);
  }
  return rate;
}

// Gate row layout: [ts_str, vol_quote, close, high, low, open, vol_base, ...]
// "close" is at index 2 (different from every other adapter's OHLCV order).
function parseStableRow(row: unknown[]): { timestamp: Date; rate: number } {
  const tsSec = Number(row[0]);
  const close = Number(row[2]);
  return {
    timestamp: new Date(tsSec * 1000),
    rate: checkRateBound("gate.USDC_USDT", 1 / close),
  };
}

/**
 * Gate local USDT/USD rate. Derivation: rate = 1 / USDC_USDT close (USDC ≈ $1).
 */
export async function fetchGateStableRate(minuteTs: Date): Promise<number> {
  const fromSec = Math.floor(minuteTs.getTime() / 1000);
  const toSec   = fromSec + 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=USDC_USDT&interval=1m&from=${fromSec}&to=${toSec}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await throwIfNotOk(res, url);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data) || !data.length) throw new Error("No USDC_USDT candle returned");
    return parseStableRow(data[0]).rate;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Range backfill — USDC_USDT candles.
 */
export async function fetchGateStableRange(endTime: Date, limit: number): Promise<{ timestamp: Date; rate: number }[]> {
  const toSec   = Math.floor(endTime.getTime() / 1000);
  const fromSec = toSec - Math.min(limit, 1000) * 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=USDC_USDT&interval=1m&from=${fromSec}&to=${toSec}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await throwIfNotOk(res, url);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data)) throw new Error("Unexpected response shape");
    return data
      .map(parseStableRow)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGateCandle(symbol: string, minuteTs: Date): Promise<SourceCandle> {
  const fromSec = Math.floor(minuteTs.getTime() / 1000);
  const toSec   = fromSec + 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=1m&from=${fromSec}&to=${toSec}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await throwIfNotOk(res, url);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data) || !data.length) throw new EmptyCandleError("gate");
    return parseRow(data[0]).candle;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGateRange(symbol: string, endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const toSec   = Math.floor(endTime.getTime() / 1000);
  const fromSec = toSec - Math.min(limit, 1000) * 60;
  const url = `${BASE}/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=1m&from=${fromSec}&to=${toSec}&limit=${Math.min(limit, 1000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await throwIfNotOk(res, url);
    const data = await res.json() as unknown[][];
    if (!Array.isArray(data)) throw new Error("Unexpected response shape");
    return data
      .map(parseRow)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } finally {
    clearTimeout(timer);
  }
}
