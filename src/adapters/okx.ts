/**
 * OKX adapter — BTC/USDT 1m spot candles.
 *
 * Endpoint: GET https://www.okx.com/api/v5/market/history-candles
 * Pair name: BTC-USDT (hyphen-separated).
 * Timestamps: milliseconds.
 * Rate limit: 20 req / 2s / IP.
 * Response envelope: { code, msg, data: [[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm], ...] }
 * Row order is standard OHLCV. `vol` is in the base currency (BTC), matching
 * the other adapters' convention.
 * Result order: DESCENDING by timestamp.
 *
 * Pagination cursor semantics on this endpoint:
 *   `after`  → records whose timestamp is < this value (older than).
 *   `before` → records whose timestamp is > this value (newer than).
 */
import type { SourceCandle } from "../types/index.js";

const BASE = "https://www.okx.com";
const TIMEOUT_MS = 6000;
const RANGE_TIMEOUT_MS = 30000;
// OKX history-candles caps a single call at 100 rows.
const OKX_MAX_LIMIT = 100;

interface OkxRow { 0: string; 1: string; 2: string; 3: string; 4: string; 5: string; }

export async function fetchOkxCandle(symbol: string, minuteTs: Date): Promise<SourceCandle> {
  // Tight window straddling the requested minute. Pulling limit=1 with both
  // bounds set means at most one record can match.
  const before = minuteTs.getTime() - 1;            // strictly newer than the previous minute
  const after  = minuteTs.getTime() + 60000;        // strictly older than the next minute
  const url = `${BASE}/api/v5/market/history-candles?instId=${symbol}&bar=1m&before=${before}&after=${after}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const json = await res.json() as { data?: OkxRow[]; code?: string; msg?: string };
    if (json.code && json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg ?? "error"}`);
    const data = json.data ?? [];
    if (!data.length) throw new Error("No candle returned");
    const [, o, h, l, c, v] = data[0] as unknown as string[];
    return {
      open: Number(o),
      high: Number(h),
      low:  Number(l),
      close:Number(c),
      volume: Number(v),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOkxRange(symbol: string, endTime: Date, limit: number): Promise<{ timestamp: Date; candle: SourceCandle }[]> {
  // Paginate internally because OKX caps each call at 100 rows. Walk backward
  // by setting `after` to the oldest timestamp seen so far on the next call.
  const want = Math.min(limit, 1000);
  const collected: { timestamp: Date; candle: SourceCandle }[] = [];

  let cursorAfter: number = endTime.getTime() + 1;   // strictly older than this — first call wants <= endTime
  let safety = 20;                                    // 20 × 100 = 2000 rows max — defensive bound
  while (collected.length < want && safety-- > 0) {
    const remaining = want - collected.length;
    const pageLimit = Math.min(OKX_MAX_LIMIT, remaining);
    const url = `${BASE}/api/v5/market/history-candles?instId=${symbol}&bar=1m&after=${cursorAfter}&limit=${pageLimit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
    let data: OkxRow[];
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const json = await res.json() as { data?: OkxRow[]; code?: string; msg?: string };
      if (json.code && json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg ?? "error"}`);
      data = json.data ?? [];
    } finally {
      clearTimeout(timer);
    }

    if (!data.length) break;
    for (const row of data) {
      const ts = Number((row as unknown as string[])[0]);
      const [, o, h, l, c, v] = row as unknown as string[];
      collected.push({
        timestamp: new Date(ts),
        candle: {
          open: Number(o), high: Number(h), low: Number(l), close: Number(c),
          volume: Number(v),
        },
      });
    }

    // OKX returns DESC; the last row in the page is the oldest. Step the
    // cursor past it for the next page.
    const oldestTs = Number((data[data.length - 1] as unknown as string[])[0]);
    if (!Number.isFinite(oldestTs) || oldestTs >= cursorAfter) break;
    cursorAfter = oldestTs;

    // Loose throttle to keep us under 20 req / 2s.
    await new Promise((r) => setTimeout(r, 110));
  }

  return collected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
