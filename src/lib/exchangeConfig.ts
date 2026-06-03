/**
 * Per-exchange repair tuning, read from the tracked exchange_config.json at the
 * repo root (candleserv-repair-rework Stage 0/5, decision D4). Holds each venue's
 * tile_size / throttle_ms / timeout_ms and empirically-probed candle + peg depth
 * (minutes back from now the venue actually serves). NOT env vars, NOT a DB table
 * — a tracked JSON file plus an ephemeral per-run override for one-offs.
 *
 * The file is loaded once and cached. The probe (cli/probe-earliest.ts --write)
 * is what refreshes it on disk; this module only reads.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { log } from "./log.js";

export interface ExchangeTuning {
  tile_size: number;
  throttle_ms: number;
  timeout_ms: number;
  candle_depth_minutes: Record<string, number>;  // per currency (BTC-only today)
  peg_depth_minutes: number | null;              // null = USD-native (no peg)
}

// src/lib/../../ and dist/lib/../../ both resolve to the repo root, where the
// tracked exchange_config.json lives (matches schema.ts's func.sql resolution).
const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "exchange_config.json");

let cache: Record<string, ExchangeTuning> | null = null;
const runOverrides: Record<string, Partial<ExchangeTuning>> = {};

function loadFile(): Record<string, ExchangeTuning> {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  const out: Record<string, ExchangeTuning> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "_meta") continue;
    out[key] = val as ExchangeTuning;
  }
  cache = out;
  return cache;
}

/**
 * Tuning for a source, with any ephemeral per-run override applied on top.
 * Throws loud if the source is absent from the config — a repair must not guess
 * a rate limit (no silent default that could burst a venue past its cap).
 */
export function getExchangeTuning(source: string): ExchangeTuning {
  const base = loadFile()[source];
  if (!base) {
    throw new Error(`[exchangeConfig] no tuning for source '${source}' in exchange_config.json — add it (probe-earliest --write) before repairing`);
  }
  const ovr = runOverrides[source];
  return ovr ? { ...base, ...ovr } : base;
}

/** Ephemeral per-run tile/throttle/timeout override for one-offs (advanced repair UI). Not persisted. */
export function setRunOverride(source: string, override: Partial<ExchangeTuning>): void {
  runOverrides[source] = { ...runOverrides[source], ...override };
  log(`[exchangeConfig] run-override ${source}: ${JSON.stringify(override)}`);
}

/** Drop all per-run overrides (call at the end of a repair run). */
export function clearRunOverrides(): void {
  for (const k of Object.keys(runOverrides)) delete runOverrides[k];
}
