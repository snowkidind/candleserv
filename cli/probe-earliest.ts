/**
 * One-off research probe: empirically discover how far back each adapter serves
 * 1m data, per currency. Binary-searches the earliest endTime at which the venue
 * returns data, then reports the actual earliest timestamp. Probes TWO
 * independent depths per venue (Stage 0 of plans/candleserv-repair-rework.md):
 *   (a) candle history per (source, currency) — via the raw fetchRange exports;
 *   (b) peg history per USDT source — how far back its USDT→USD pair serves, via
 *       the raw fetch*StableRange exports. These differ: a venue can have deep
 *       candles but a shallow peg (e.g. bybit) and so cannot be USD-normalized
 *       beyond its peg depth. USD-native venues have no peg fetcher → peg depth
 *       is reported as `null` ("no peg needed", NOT "unknown"/error).
 *
 * Calls the RAW per-adapter fetch functions directly (NOT the rate-gated
 * registry) so it needs no DB / DATABASE_URL — venueGate reads rate-limit
 * settings from app_settings, which is irrelevant to a history probe. Pacing is
 * handled here with a per-venue delay. OutOfHistory / network errors are
 * reported loudly per (source,currency), never swallowed.
 *
 *   npx tsx cli/probe-earliest.ts            # all currencies, all sources — print only
 *   npx tsx cli/probe-earliest.ts BTC        # one currency — print only
 *   npx tsx cli/probe-earliest.ts BTC --write  # merge probed depths into exchange_config.json
 *
 * With --write the probe MERGES into the existing hand-seeded exchange_config.json:
 * it updates `candle_depth_minutes.<CURRENCY>` and `peg_depth_minutes` only for
 * venues it could actually reach, preserves `_meta`/tile/throttle/timeout/_note
 * and any venue it couldn't reach, and never clobbers a stored depth to zero.
 */
process.env.TZ = "UTC";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchBinanceRange, fetchBinanceStableRange } from "../src/adapters/binance.js";
import { fetchBybitRange, fetchBybitStableRange } from "../src/adapters/bybit.js";
import { fetchKrakenRange } from "../src/adapters/kraken.js";
import { fetchCoinbaseRange } from "../src/adapters/coinbase.js";
import { fetchBitfinexRange } from "../src/adapters/bitfinex.js";
import { fetchOkxRange } from "../src/adapters/okx.js";
import { fetchGateRange, fetchGateStableRange } from "../src/adapters/gate.js";
import { fetchBitgetRange, fetchBitgetStableRange } from "../src/adapters/bitget.js";
import { SYMBOL_MAP, SUPPORTED_CURRENCIES, symbolFor } from "../src/adapters/symbolMap.js";
import { isOutOfHistory } from "../src/adapters/errors.js";
import type { SourceCandle } from "../src/types/index.js";

type RangeFn = (symbol: string, endTime: Date, limit: number) => Promise<{ timestamp: Date; candle: SourceCandle }[]>;
type PegRangeFn = (endTime: Date, limit: number) => Promise<{ timestamp: Date; rate: number }[]>;

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

// Raw peg-range fetchers — USDT venues only. USD-native venues are intentionally
// absent: they have no peg fetcher, so peg_depth_minutes stays null for them.
const PEG_FETCH: Record<string, PegRangeFn> = {
  binance: fetchBinanceStableRange,
  bybit:   fetchBybitStableRange,
  gate:    fetchGateStableRange,
  bitget:  fetchBitgetStableRange,
};

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

// A "probe at minute P" check: fetch the window [P, P+WINDOW] and report whether
// data exists at-or-before P, plus the earliest timestamp seen in that window.
type ProbeAt = (p: number) => Promise<{ has: boolean; earliest: number | null }>;

// Candle probe-at: earliest of the [P, P+WINDOW] candle window vs P.
function candleProbeAt(source: string, symbol: string): ProbeAt {
  return async (p) => {
    const endTime = new Date(Math.min(p + WINDOW_MS, UPPER));
    const rows = await FETCH[source](symbol, endTime, PROBE_LIMIT);
    if (!rows.length) return { has: false, earliest: null };
    const earliest = Math.min(...rows.map((r) => r.timestamp.getTime()));
    return { has: earliest <= p + 60_000, earliest };
  };
}

// Peg probe-at: same shape over the venue's USDT→USD peg range (no symbol arg).
function pegProbeAt(source: string): ProbeAt {
  const fetchPeg = PEG_FETCH[source];
  return async (p) => {
    const endTime = new Date(Math.min(p + WINDOW_MS, UPPER));
    const rows = await fetchPeg(endTime, PROBE_LIMIT);
    if (!rows.length) return { has: false, earliest: null };
    const earliest = Math.min(...rows.map((r) => r.timestamp.getTime()));
    return { has: earliest <= p + 60_000, earliest };
  };
}

// Binary-search the smallest probe date P where data exists at-or-before P, then
// a final precise read at the boundary. Shared by the candle and peg probes.
async function binarySearchEarliest(probeAt: ProbeAt, delay: number): Promise<Outcome> {
  let calls = 0;
  let lo = LOWER;
  let hi = UPPER;
  let bestEarliest: number | null = null;
  let sawOutOfHistory = false;

  while (hi - lo > 12 * 3600_000) { // ~12h resolution
    const mid = lo + Math.floor((hi - lo) / 2);
    calls++;
    try {
      const { has, earliest } = await probeAt(mid);
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

  // Final precise fetch near the boundary to read the true earliest timestamp.
  try {
    calls++;
    const { earliest } = await probeAt(hi);
    if (earliest !== null) bestEarliest = bestEarliest === null ? earliest : Math.min(bestEarliest, earliest);
    await sleep(delay);
  } catch { /* keep bestEarliest from search */ }

  if (bestEarliest === null) return { kind: "error", message: "no data returned across full range" };
  // If the earliest we could ever get is within ~30d of now, the venue caps history (e.g. gate).
  const capped = sawOutOfHistory || bestEarliest > Date.now() - 30 * 86400_000;
  return { kind: capped ? "capped" : "ok", earliest: new Date(bestEarliest), calls };
}

async function probe(source: string, currency: string): Promise<Outcome> {
  let symbol: string;
  try {
    symbol = symbolFor(currency, source);
  } catch {
    return { kind: "unmapped" };
  }
  return binarySearchEarliest(candleProbeAt(source, symbol), DELAY_MS[source] ?? DEFAULT_DELAY_MS);
}

// Peg depth per USDT venue. USD-native venues have no peg fetcher → `null`
// outcome, surfaced as peg_depth_minutes: null ("no peg needed", not an error).
async function probePeg(source: string): Promise<Outcome | { kind: "no-peg" }> {
  if (!PEG_FETCH[source]) return { kind: "no-peg" };
  return binarySearchEarliest(pegProbeAt(source), DELAY_MS[source] ?? DEFAULT_DELAY_MS);
}

function iso(d: Date): string { return d.toISOString().slice(0, 10); }

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "exchange_config.json");

// Earliest timestamp → "minutes back from now" depth, minus the safety buffer.
// Never buffer a shallow/capped venue down to <=0 — that would silently make it
// un-repairable (e.g. kraken's ~720-candle window). Store the raw depth instead.
function depthMinutesFromEarliest(earliest: Date, buffer: number): number {
  const raw = Math.floor((Date.now() - earliest.getTime()) / 60000);
  return raw > buffer ? raw - buffer : raw;
}

// Merge probed depths into the hand-seeded exchange_config.json. Only reachable
// venues (ok/capped) update; unreachable/errored venues keep their stored depth
// (fail-loud, never clobber-to-zero). Preserves _meta / tile / throttle / timeout
// / _note and any venue the run didn't touch.
function writeConfig(
  currencies: string[],
  candleResults: Record<string, Record<string, Outcome>>,
  pegResults: Record<string, Outcome | { kind: "no-peg" }>,
): void {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>;
  const buffer: number = cfg._meta?.safety_buffer_minutes ?? 1440;
  console.log(`\n===== MERGE-WRITE → ${CONFIG_PATH} (buffer ${buffer}m) =====\n`);

  // Candle depths — per (source, currency).
  for (const currency of currencies) {
    for (const source of SOURCE_NAMES) {
      const out = candleResults[currency][source];
      if (out.kind === "ok" || out.kind === "capped") {
        const venue = (cfg[source] ??= {});
        const depths = (venue.candle_depth_minutes ??= {});
        const prev = depths[currency];
        const next = depthMinutesFromEarliest(out.earliest, buffer);
        depths[currency] = next;
        if (prev !== next) console.log(`  ${source} candle_depth_minutes.${currency}: ${prev ?? "—"} → ${next}`);
      } else {
        console.log(`  ${source} candle ${currency}: ${out.kind === "error" ? "ERROR" : out.kind} — stored depth left untouched`);
      }
    }
  }

  // Peg depths — per source (shared USDT→USD). null for USD-native venues.
  for (const source of SOURCE_NAMES) {
    const out = pegResults[source];
    const venue = (cfg[source] ??= {});
    if (out.kind === "no-peg") {
      if (!("peg_depth_minutes" in venue)) { venue.peg_depth_minutes = null; console.log(`  ${source} peg_depth_minutes: → null (USD-native)`); }
    } else if (out.kind === "ok" || out.kind === "capped") {
      const prev = venue.peg_depth_minutes;
      const next = depthMinutesFromEarliest(out.earliest, buffer);
      venue.peg_depth_minutes = next;
      if (prev !== next) console.log(`  ${source} peg_depth_minutes: ${prev ?? "—"} → ${next}`);
    } else {
      console.log(`  ${source} peg: ${out.kind === "error" ? "ERROR" : out.kind} — stored peg depth left untouched`);
    }
  }

  cfg._meta = cfg._meta ?? {};
  cfg._meta.probed_at = new Date().toISOString().slice(0, 16) + "Z";
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\n[write] merged probed depths into exchange_config.json (probed_at=${cfg._meta.probed_at})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const currencyArg = argv.find((a) => !a.startsWith("--"))?.toUpperCase();
  const currencies = currencyArg ? [currencyArg] : SUPPORTED_CURRENCIES;
  console.log(`probing earliest 1m history — currencies: ${currencies.join(", ")} | sources: ${SOURCE_NAMES.join(", ")}${write ? " | --write" : ""}`);
  console.log(`range floor: ${iso(new Date(LOWER))}  ceiling: ${iso(new Date(UPPER))}\n`);

  // (a) Candle depth — per (source, currency).
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

  // (b) Peg depth — per USDT source (shared USDT→USD; independent of candle depth).
  console.log("\nprobing peg (USDT→USD) depth per venue...");
  const pegResults: Record<string, Outcome | { kind: "no-peg" }> = {};
  for (const source of SOURCE_NAMES) {
    process.stdout.write(`  peg ${source.padEnd(9)} ... `);
    const out = await probePeg(source);
    pegResults[source] = out;
    if (out.kind === "no-peg") console.log("USD-native (no peg)");
    else if (out.kind === "ok") console.log(`earliest ${iso(out.earliest)}  (${out.calls} calls)`);
    else if (out.kind === "capped") console.log(`CAPPED — only back to ${iso(out.earliest)}  (${out.calls} calls)`);
    else console.log(`ERROR — ${out.message}`);
  }

  // Markdown chart — candle history.
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

  // Shallow-peg flags — a USDT venue with deep candles but a shallow peg cannot be
  // USD-normalized beyond its peg depth; surface it BEFORE a multi-hour run.
  console.log("===== SHALLOW-PEG FLAGS =====\n");
  let flagged = false;
  for (const source of SOURCE_NAMES) {
    const peg = pegResults[source];
    if (peg.kind !== "ok" && peg.kind !== "capped") continue;
    const candle = results["BTC"]?.[source];
    if (!candle || (candle.kind !== "ok" && candle.kind !== "capped")) continue;
    if (peg.earliest.getTime() > candle.earliest.getTime()) {
      flagged = true;
      console.log(`  ⚠ ${source}: candles deep (${iso(candle.earliest)}) but peg shallow (${iso(peg.earliest)}) — cannot USD-normalize beyond peg depth; omit from the formula for windows deeper than its peg.`);
    }
  }
  if (!flagged) console.log("  (none, or BTC not in this run — every probed USDT venue's peg reaches at least as far back as its candles)");

  if (write) writeConfig(currencies, results, pegResults);
  else console.log("\n(print-only — pass --write to merge these depths into exchange_config.json)");
}

main().catch((err) => { console.error("probe fatal:", err); process.exit(1); });
