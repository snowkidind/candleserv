/**
 * One-off research probe: empirically discover how far back each adapter serves
 * 1m candle data, per currency. Binary-searches the earliest endTime at which
 * the venue returns data, then reports the actual earliest candle timestamp.
 *
 * Calls the RAW per-adapter fetchRange functions directly (NOT the rate-gated
 * registry) so it needs no DB / DATABASE_URL — venueGate reads rate-limit
 * settings from app_settings, which is irrelevant to a history probe. Pacing is
 * handled here with a per-venue delay. OutOfHistory / network errors are
 * reported loudly per (source,currency), never swallowed.
 *
 *   npx tsx cli/probe-earliest.ts          # all currencies, all sources
 *   npx tsx cli/probe-earliest.ts BTC      # one currency
 */
process.env.TZ = "UTC";
import { fetchBinanceRange } from "../src/adapters/binance.js";
import { fetchBybitRange } from "../src/adapters/bybit.js";
import { fetchKrakenRange } from "../src/adapters/kraken.js";
import { fetchCoinbaseRange } from "../src/adapters/coinbase.js";
import { fetchBitfinexRange } from "../src/adapters/bitfinex.js";
import { fetchOkxRange } from "../src/adapters/okx.js";
import { fetchGateRange } from "../src/adapters/gate.js";
import { fetchBitgetRange } from "../src/adapters/bitget.js";
import { SYMBOL_MAP, SUPPORTED_CURRENCIES, symbolFor } from "../src/adapters/symbolMap.js";
import { isOutOfHistory } from "../src/adapters/errors.js";
import type { SourceCandle } from "../src/types/index.js";

type RangeFn = (symbol: string, endTime: Date, limit: number) => Promise<{ timestamp: Date; candle: SourceCandle }[]>;

const FETCH: Record<string, RangeFn> = {
  binance:  fetchBinanceRange,
  bybit:    fetchBybitRange,
  kraken:   fetchKrakenRange,
  coinbase: fetchCoinbaseRange,
  bitfinex: fetchBitfinexRange,
  okx:      fetchOkxRange,
  gate:     fetchGateRange,
  bitget:   fetchBitgetRange,
};
const SOURCE_NAMES = Object.keys(FETCH);

const LOWER = new Date("2011-01-01T00:00:00Z").getTime();
const UPPER = Date.now() - 2 * 86400_000; // 2 days ago, safely closed
const PROBE_LIMIT = 200;                  // candles per probe call
const WINDOW_MS = PROBE_LIMIT * 60_000;
// Kraken is the only venue with a tight public rate limit; pace it slower.
const DELAY_MS: Record<string, number> = { kraken: 3500 };
const DEFAULT_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome =
  | { kind: "ok"; earliest: Date; calls: number }
  | { kind: "capped"; earliest: Date; calls: number }   // returned data but only very recent (e.g. gate ~7d)
  | { kind: "unmapped" }
  | { kind: "error"; message: string };

// Does data exist at-or-before probe date P? Fetch the window [P, P+WINDOW] and
// check whether the earliest returned candle is <= P (i.e. P sits inside history).
async function hasDataAtOrBefore(source: string, symbol: string, p: number): Promise<{ has: boolean; earliest: number | null }> {
  const endTime = new Date(Math.min(p + WINDOW_MS, UPPER));
  const rows = await FETCH[source](symbol, endTime, PROBE_LIMIT);
  if (!rows.length) return { has: false, earliest: null };
  const earliest = Math.min(...rows.map((r) => r.timestamp.getTime()));
  return { has: earliest <= p + 60_000, earliest };
}

async function probe(source: string, currency: string): Promise<Outcome> {
  let symbol: string;
  try {
    symbol = symbolFor(currency, source);
  } catch {
    return { kind: "unmapped" };
  }

  const delay = DELAY_MS[source] ?? DEFAULT_DELAY_MS;
  let calls = 0;
  let lo = LOWER;
  let hi = UPPER;
  let bestEarliest: number | null = null;
  let sawOutOfHistory = false;

  // Binary search the smallest probe date P where data exists at-or-before P.
  while (hi - lo > 12 * 3600_000) { // ~12h resolution
    const mid = lo + Math.floor((hi - lo) / 2);
    calls++;
    try {
      const { has, earliest } = await hasDataAtOrBefore(source, symbol, mid);
      if (has) {
        if (earliest !== null) bestEarliest = bestEarliest === null ? earliest : Math.min(bestEarliest, earliest);
        hi = mid;
      } else {
        lo = mid;
      }
    } catch (err) {
      if (isOutOfHistory(err)) { sawOutOfHistory = true; lo = mid; } // too old for this venue
      else return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    await sleep(delay);
  }

  // Final precise fetch near the boundary to read the true earliest candle.
  try {
    calls++;
    const { earliest } = await hasDataAtOrBefore(source, symbol, hi);
    if (earliest !== null) bestEarliest = bestEarliest === null ? earliest : Math.min(bestEarliest, earliest);
    await sleep(delay);
  } catch { /* keep bestEarliest from search */ }

  if (bestEarliest === null) return { kind: "error", message: "no data returned across full range" };
  // If the earliest we could ever get is within ~30d of now, the venue caps history (e.g. gate).
  const capped = sawOutOfHistory || bestEarliest > Date.now() - 30 * 86400_000;
  return { kind: capped ? "capped" : "ok", earliest: new Date(bestEarliest), calls };
}

function iso(d: Date): string { return d.toISOString().slice(0, 10); }

async function main(): Promise<void> {
  const arg = process.argv[2]?.toUpperCase();
  const currencies = arg ? [arg] : SUPPORTED_CURRENCIES;
  console.log(`probing earliest 1m history — currencies: ${currencies.join(", ")} | sources: ${SOURCE_NAMES.join(", ")}`);
  console.log(`range floor: ${iso(new Date(LOWER))}  ceiling: ${iso(new Date(UPPER))}\n`);

  const results: Record<string, Record<string, Outcome>> = {};
  for (const currency of currencies) {
    results[currency] = {};
    for (const source of SOURCE_NAMES) {
      process.stdout.write(`  ${currency.padEnd(4)} ${source.padEnd(9)} ... `);
      const out = await probe(source, currency);
      results[currency][source] = out;
      if (out.kind === "ok") console.log(`earliest ${iso(out.earliest)}  (${out.calls} calls)`);
      else if (out.kind === "capped") console.log(`CAPPED — only back to ${iso(out.earliest)}  (${out.calls} calls)`);
      else if (out.kind === "unmapped") console.log(`unmapped`);
      else console.log(`ERROR — ${out.message}`);
    }
  }

  // Markdown chart.
  console.log("\n\n===== EARLIEST 1m HISTORY (by exchange) =====\n");
  const header = ["currency", ...SOURCE_NAMES];
  console.log("| " + header.join(" | ") + " |");
  console.log("|" + header.map(() => "---").join("|") + "|");
  for (const currency of currencies) {
    const cells = SOURCE_NAMES.map((s) => {
      const o = results[currency][s];
      if (o.kind === "ok") return iso(o.earliest);
      if (o.kind === "capped") return `(cap) ${iso(o.earliest)}`;
      if (o.kind === "unmapped") return "—";
      return "ERR";
    });
    console.log("| " + [currency, ...cells].join(" | ") + " |");
  }
  console.log("\n(cap) = venue caps history (cannot backfill earlier than shown). ERR = unreachable from this host. — = symbol not mapped.\n");
}

main().catch((err) => { console.error("probe fatal:", err); process.exit(1); });
