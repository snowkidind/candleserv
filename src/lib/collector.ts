import { fetchBinanceCandle } from "../adapters/binance.js";
import { fetchBybitCandle } from "../adapters/bybit.js";
import { fetchKrakenCandle } from "../adapters/kraken.js";
import { fetchCoinbaseCandle } from "../adapters/coinbase.js";
import { fetchBitfinexCandle } from "../adapters/bitfinex.js";
import { applyGuards, buildComposite } from "./composite.js";
import { upsertCandle, upsertSourceCandle, getSourceCountBaseline, getRecentCloseStddev, getTrailingVolumeLeader } from "../db/candles.js";
import { recordError } from "../db/errors.js";
import { candleEmitter } from "./emitter.js";
import { rowToJson } from "../db/candles.js";
import { insertStreamEvent } from "../db/streamEvents.js";
import { getSettingInt, setSetting } from "../db/appSettings.js";
import { log, logError, logWarn } from "./log.js";
import type { SourceResult } from "../types/index.js";

const DEADLINE_MS = 15000; // 15 seconds from :00 to write
const SOURCES = ["binance", "bybit", "kraken", "coinbase", "bitfinex"];

// Per-source 24h failure counters for auto-pause
const failureCounters: Record<string, number[]> = {};
for (const s of SOURCES) failureCounters[s] = [];

// Paused sources (until manually re-enabled)
const pausedSources = new Set<string>();

// Overlap guard
let collectionRunning = false;

// Previous states for source_state SSE events
const sourceStates: Record<string, string> = {};

function recordFailure(source: string): void {
  const now = Date.now();
  failureCounters[source] = failureCounters[source].filter((t) => now - t < 24 * 60 * 60 * 1000);
  failureCounters[source].push(now);
}

async function checkAutoPause(source: string): Promise<void> {
  const threshold = await getSettingInt("sourceAutoSuspendThreshold", 10);
  if (failureCounters[source].length >= threshold) {
    if (!pausedSources.has(source)) {
      pausedSources.add(source);
      logWarn(`[collector] auto-paused ${source} after ${failureCounters[source].length} failures in 24h`);
      await insertStreamEvent(source, "paused");
      await recordError("collector", "checkAutoPause", `Auto-paused ${source}: ${failureCounters[source].length} failures in 24h`);
      emitSourceState(source, "paused");
    }
  }
}

function emitSourceState(source: string, newState: string): void {
  const previous = sourceStates[source] ?? "unknown";
  if (previous === newState) return;
  sourceStates[source] = newState;
  candleEmitter.emit("source_state", {
    source,
    state: newState,
    previousState: previous,
    timestamp: Date.now(),
  });
}

export function isSourcePaused(source: string): boolean {
  return pausedSources.has(source);
}

export function resumeSource(source: string): void {
  pausedSources.delete(source);
  failureCounters[source] = [];
  emitSourceState(source, "on");
}

export function getSourceStatus(): Record<string, { paused: boolean; failures24h: number; state: string }> {
  const result: Record<string, { paused: boolean; failures24h: number; state: string }> = {};
  for (const s of SOURCES) {
    result[s] = {
      paused: pausedSources.has(s),
      failures24h: failureCounters[s].length,
      state: sourceStates[s] ?? "unknown",
    };
  }
  return result;
}

/**
 * Fetch one 1m candle from a single source, with timeout handled by the adapter.
 */
async function fetchOne(source: string, minuteTs: Date): Promise<SourceResult> {
  if (pausedSources.has(source)) {
    return { source, candle: null, error: "paused" };
  }
  const t0 = Date.now();
  try {
    let candle;
    switch (source) {
      case "binance":  candle = await fetchBinanceCandle(minuteTs);  break;
      case "bybit":    candle = await fetchBybitCandle(minuteTs);    break;
      case "kraken":   candle = await fetchKrakenCandle(minuteTs);   break;
      case "coinbase": candle = await fetchCoinbaseCandle(minuteTs); break;
      case "bitfinex": candle = await fetchBitfinexCandle(minuteTs); break;
      default: return { source, candle: null, error: "unknown source" };
    }
    emitSourceState(source, "on");
    return { source, candle, durationMs: Date.now() - t0 };
  } catch (err) {
    recordFailure(source);
    await checkAutoPause(source);
    emitSourceState(source, "error");
    await recordError("collector", `fetchOne:${source}`, String(err));
    return { source, candle: null, error: String(err), durationMs: Date.now() - t0 };
  }
}

/**
 * Run one collection cycle for the given minute boundary.
 * Returns true if a candle was written within the deadline, false otherwise.
 */
export async function collect(minuteTs: Date): Promise<boolean> {
  if (collectionRunning) {
    logWarn("[collector] previous run still active — skipping this trigger");
    return false;
  }
  collectionRunning = true;

  const deadline = Date.now() + DEADLINE_MS;

  try {
    const results = await Promise.all(SOURCES.map((s) => fetchOne(s, minuteTs)));

    if (Date.now() > deadline) {
      const timings = results.map(r => `${r.source}:${r.durationMs ?? "?"}ms`).join(" ");
      logError(`[collector] deadline exceeded for ${minuteTs.toISOString()} — ${timings}`);
      await recordError("collector", "deadline", `Deadline exceeded for ${minuteTs.toISOString()} — ${timings}`);
      return false;
    }

    const minSources   = await getSettingInt("minSources", 3);
    const baseline     = await getSourceCountBaseline();
    const sigma        = await getRecentCloseStddev();
    const volumeLeader = await getTrailingVolumeLeader(10);
    const guarded      = applyGuards(results, minSources, sigma);

    // Upsert per-source rows
    for (const g of guarded) {
      if (!g.candle) continue;
      await upsertSourceCandle({
        timestamp: minuteTs,
        source: g.source,
        ...g.candle,
        rejected: g.rejected,
        rejectedReason: g.rejectedReason,
      });
    }

    const composite = await buildComposite(guarded, baseline, volumeLeader ?? undefined, minuteTs);

    if (Date.now() > deadline) {
      logError(`[collector] deadline exceeded after composite for ${minuteTs.toISOString()} — skipping write`);
      await recordError("collector", "deadline", `Deadline exceeded after composite for ${minuteTs.toISOString()}`);
      return false;
    }

    await upsertCandle({ timestamp: minuteTs, ...composite });

    const json = rowToJson({
      timestamp: minuteTs,
      open: composite.open,
      high: composite.high,
      low: composite.low,
      close: composite.close,
      volume: composite.volume,
      volumeNormalized: composite.volumeNormalized,
      sourceCount: composite.sourceCount,
      sourceCountBaseline: composite.sourceCountBaseline,
      sources: composite.sources,
      confidence: composite.confidence,
    });

    candleEmitter.emit("candle", json);
    log(`[collector] wrote candle ${minuteTs.toISOString()} sources=${composite.sourceCount} confidence=${composite.confidence.toFixed(2)}`);
    return true;
  } catch (err) {
    logError("[collector] collect failed:", err);
    await recordError("collector", "collect", String(err));
    return false;
  } finally {
    collectionRunning = false;
  }
}

/**
 * Cronjob: fires at :04 past each minute.
 */
export function startCollector(): void {
  log("[collector] starting");
  scheduleNext();
}

function scheduleNext(): void {
  const now = Date.now();
  const nextMinute = Math.ceil(now / 60000) * 60000;
  const fireAt = nextMinute + 4000; // :04 past the minute
  const delay = fireAt - now;

  setTimeout(async () => {
    // Record heartbeat so we can detect outages after power failure
    void setSetting("lastHeartbeat", new Date().toISOString()).catch(() => {});
    // The candle we want is the minute that just closed
    const minuteTs = new Date(nextMinute - 60000);
    await collect(minuteTs);
    scheduleNext();
  }, delay);
}
