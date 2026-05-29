/**
 * Outgoing exchange-request counters. Records every request we ISSUE to an
 * exchange, dimensioned by (currency, venue/source, type). In-process,
 * minute-bucketed, pruned to 24h — powers rolling 1h/4h/8h/24h windows (read via
 * the CLI `api` command / GET /internal/api-stats) and a once-a-day log summary.
 *
 * Counts are operational telemetry, reset on restart; the daily log line is the
 * durable record. Bounded: ≤1440 minute buckets × a small key set.
 *
 * Call sites that MUST stay instrumented (keep this list current):
 *   - collector live candle wave  → recordApiRequest(currency, source, "live")
 *   - collector peg wave          → recordApiRequest(PEG_CURRENCY, source, "peg")
 *   - healer healRange            → recordApiRequest(currency, source, "backfill")
 *   - healer healMinute           → recordApiRequest(currency, source, "heal1m")
 *   - repair ensureSourceCoverage → recordApiRequest(currency, source, "repair")
 *   - availability probe          → recordApiRequest(currency, source, "probe")
 */
import { log } from "./log.js";

export type ApiReqType = "live" | "peg" | "backfill" | "heal1m" | "repair" | "probe";

// Peg fetches are asset-independent (one per venue, shared across currencies), so
// they're bucketed under this pseudo-currency rather than attributed to an asset.
export const PEG_CURRENCY = "PEG";

const BUCKET_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

// minute-epoch → (`${currency}|${source}|${type}` → count)
const buckets = new Map<number, Map<string, number>>();
let lastPrune = 0;

export function recordApiRequest(currency: string, source: string, type: ApiReqType): void {
  const now = Date.now();
  const minute = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  let b = buckets.get(minute);
  if (!b) { b = new Map(); buckets.set(minute, b); }
  const key = `${currency}|${source}|${type}`;
  b.set(key, (b.get(key) ?? 0) + 1);
  if (now - lastPrune >= BUCKET_MS) { lastPrune = now; prune(now); }
}

function prune(now: number): void {
  const cutoff = now - RETENTION_MS;
  for (const m of buckets.keys()) if (m < cutoff) buckets.delete(m);
}

export interface ApiCountRow { currency: string; source: string; type: ApiReqType; count: number; }
export interface ApiWindow {
  total: number;
  byCurrency: Record<string, number>;
  byType: Record<string, number>;
  rows: ApiCountRow[];           // sorted desc by count
}

function aggregate(windowMs: number): ApiWindow {
  const cutoff = Date.now() - windowMs;
  const combined = new Map<string, number>();
  for (const [minute, b] of buckets) {
    if (minute < cutoff) continue;
    for (const [k, c] of b) combined.set(k, (combined.get(k) ?? 0) + c);
  }
  const rows: ApiCountRow[] = [];
  const byCurrency: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let total = 0;
  for (const [k, count] of combined) {
    const [currency, source, type] = k.split("|") as [string, string, ApiReqType];
    rows.push({ currency, source, type, count });
    byCurrency[currency] = (byCurrency[currency] ?? 0) + count;
    byType[type] = (byType[type] ?? 0) + count;
    total += count;
  }
  rows.sort((a, b) => b.count - a.count);
  return { total, byCurrency, byType, rows };
}

export interface ApiStatsSnapshot {
  generatedAt: string;
  windows: Record<"1h" | "4h" | "8h" | "24h", ApiWindow>;
}

export function apiStatsSnapshot(): ApiStatsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    windows: {
      "1h": aggregate(3_600_000),
      "4h": aggregate(4 * 3_600_000),
      "8h": aggregate(8 * 3_600_000),
      "24h": aggregate(RETENTION_MS),
    },
  };
}

/** Daily summary to the log (rolling 24h window). Called from the maintenance loop. */
export function logApiSummary(): void {
  const w = aggregate(RETENTION_MS);
  const byCur = Object.entries(w.byCurrency).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`);
  const byType = Object.entries(w.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`);
  log(`[apiCounter] 24h outgoing requests: ${w.total} total`);
  log(`[apiCounter] 24h by currency: ${byCur.join(" ") || "none"}`);
  log(`[apiCounter] 24h by type: ${byType.join(" ") || "none"}`);
}
