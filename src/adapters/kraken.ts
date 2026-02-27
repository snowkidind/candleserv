import type { SourceCandle } from "../types/index";

const BASE = "https://api.kraken.com";
const TIMEOUT_MS = 6000;

/**
 * Fetch up to 720 1m candles ending before endTime (Kraken's per-call max).
 * Uses the since-forward pattern: computes since = endTime - limit*60s, fetches
 * forward, then filters to timestamp < endTime.
 * Returns rows sorted ascending by timestamp.
 */
export async function fetchKrakenRange(endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  const clampedLimit = Math.min(limit, 720);
  const since = Math.floor((endTime.getTime() - clampedLimit * 60000) / 1000);
  const url = `${BASE}/0/public/OHLC?pair=XBTUSD&interval=1&since=${since}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { error?: string[]; result?: Record<string, unknown[][]> };
    if (json.error?.length) throw new Error(json.error[0]);

    const result = json.result ?? {};
    const key = Object.keys(result).find((k) => k !== "last");
    if (!key) return [];

    const rows = result[key] as unknown[][];
    const endMs = endTime.getTime();

    return rows
      .filter((row) => Number(row[0]) * 1000 < endMs)
      .map((row) => ({
        timestamp: new Date(Number(row[0]) * 1000),
        candle: {
          open:   Number(row[1]),
          high:   Number(row[2]),
          low:    Number(row[3]),
          close:  Number(row[4]),
          volume: Number(row[6]),
        },
      }));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchKrakenCandle(minuteTs: Date): Promise<SourceCandle> {
  // Kraken since = Unix seconds. Returns up to 720 candles from 'since'.
  const since = Math.floor(minuteTs.getTime() / 1000);
  const url = `${BASE}/0/public/OHLC?pair=XBTUSD&interval=1&since=${since}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { error?: string[]; result?: Record<string, unknown[][]> };
    if (json.error?.length) throw new Error(json.error[0]);

    const result = json.result ?? {};
    const key = Object.keys(result).find((k) => k !== "last");
    if (!key) throw new Error("No data key in Kraken response");

    const rows = result[key] as unknown[][];
    if (!rows.length) throw new Error("No candle returned");

    // Kraken: [time, open, high, low, close, vwap, volume, count]
    const row = rows[0];
    return {
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6]),
    };
  } finally {
    clearTimeout(timer);
  }
}
