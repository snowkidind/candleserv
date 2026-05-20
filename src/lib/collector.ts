import { ADAPTERS, ADAPTER_BY_NAME, SOURCE_NAMES } from "../adapters/registry.js";
import { applyGuards, buildComposite } from "./composite.js";
import { upsertCandle, upsertSourceCandle, getSourceCountBaseline, getRecentCloseStddev, getTrailingVolumeLeader, get24hSourceStats } from "../db/candles.js";
import { recordError } from "../db/errors.js";
import { candleEmitter } from "./emitter.js";
import { rowToJson } from "../db/candles.js";
import { insertStreamEvent } from "../db/streamEvents.js";
import { getSettingInt, setSetting } from "../db/appSettings.js";
import {
  getCurrentFormula,
  getExchangeState,
  getFailureCount,
  insertFormulaChange,
  recordFailure,
} from "../db/formulaChanges.js";
import { log, logError, logWarn } from "./log.js";
import type { SourceResult } from "../types/index.js";

const DEADLINE_MS = 15000; // 15 seconds from :00 to write

// Overlap guard
let collectionRunning = false;

// Last fine-grained fetch state per source (for the operational UI's status
// dot — "on" vs "error"). This is finer than the formula state and only
// reflects the most recent fetch attempt.
const liveFetchStates: Record<string, "on" | "error" | "unknown"> = {};
const lastFetchAt: Record<string, Date | null> = {};

async function checkAutoSuspend(source: string): Promise<void> {
  const threshold = await getSettingInt("sourceAutoSuspendThreshold", 10);
  const failures = getFailureCount(source);
  if (failures < threshold) return;

  // Already excluded? insertFormulaChange short-circuits, but skip the snapshot
  // work entirely so we don't hammer the DB on every retry.
  const current = getExchangeState(source);
  if (current?.setOrUnset === "set") return;

  // Snapshot stats before flipping. If the snapshot query fails the helper
  // returns null fields — we still record the exclusion (per plan: degraded
  // UI label rather than dropping the exclusion).
  const stats = await get24hSourceStats(source);
  const statsAtExclusion = {
    failures24h: failures,
    outlierRate24h: stats.outlierRate24h,
    usedRate24h: stats.usedRate24h,
  };

  const reason = `${failures} failures in 24h`;
  await insertFormulaChange(source, "set", "auto-suspend", reason, statsAtExclusion);
  await recordError("collector", "checkAutoSuspend", `Auto-suspended ${source}: ${reason}`);
  logWarn(`[collector] auto-suspended ${source} via formula: ${reason}`);
  // insertFormulaChange handles SSE + stream_events for the formula transition.
  // We also emit the legacy "paused" stream event so existing UI's still see
  // a state change — Phase 6 frontend rework replaces this with formula state.
  try {
    await insertStreamEvent(source, "paused");
  } catch (err) {
    logWarn(`[collector] failed to record legacy paused stream event for ${source}: ${err}`);
  }
}

function recordLiveFetchState(source: string, newState: "on" | "error"): void {
  const previous = liveFetchStates[source] ?? "unknown";
  if (previous === newState) return;
  liveFetchStates[source] = newState;
  candleEmitter.emit("source_state", {
    source,
    state: newState,
    previousState: previous,
    timestamp: Date.now(),
  });
}

/**
 * Backward-compat shim. The formula is now the single knob — "paused" maps
 * to "in the formula's excludedSources." Kept as an exported helper for
 * pre-existing code paths during the transition; Phase 6 frontend lands the
 * full rename to "excluded."
 */
export function isSourcePaused(source: string): boolean {
  return getCurrentFormula().excludedSources.includes(source);
}

/**
 * Backward-compat shim. The POST /monitor/sources/:source/resume endpoint
 * still exists during the transition; routes here to the formula mutation.
 * insertFormulaChange clears the source's 24h failure counter on 'unset' so
 * it doesn't immediately re-trip auto-suspend.
 */
export async function resumeSource(source: string): Promise<void> {
  await insertFormulaChange(source, "unset", "manual:legacy-resume", "manual resume via /sources/:source/resume");
}

/**
 * Snapshot of per-source state for the monitoring UI. The shape includes both
 * legacy `paused` (alias for `excluded`) and the new formula-aware fields
 * (excluded, excludedReason, excludedBy, excludedAt, reason,
 * lastKnownAtExclusion). The legacy aliases let the current frontend keep
 * functioning until Phase 6 lands the rework.
 */
export interface SourceStatus {
  // Live fetch metadata — meaningful when not excluded.
  fetching: boolean;
  failures24h: number;
  lastFetch: string | null;
  state: string;            // legacy "on" | "error" | "unknown" — fine-grained live fetch state.

  // Formula state.
  excluded: boolean;
  paused: boolean;          // legacy alias for `excluded`.
  excludedReason: "manual" | "auto-suspend" | null;
  excludedBy: string | null;
  excludedAt: string | null;
  reason: string | null;
  lastKnownAtExclusion: {
    failures24h: number | null;
    outlierRate24h: number | null;
    usedRate24h: number | null;
  } | null;
}

export function getSourceStatus(): Record<string, SourceStatus> {
  const excludedNames = new Set(getCurrentFormula().excludedSources);
  const result: Record<string, SourceStatus> = {};
  for (const s of SOURCE_NAMES) {
    const excluded = excludedNames.has(s);
    const change = getExchangeState(s);
    const excludedRow = excluded && change?.setOrUnset === "set" ? change : null;
    const excludedReason: SourceStatus["excludedReason"] = excludedRow
      ? excludedRow.by === "auto-suspend"
        ? "auto-suspend"
        : excludedRow.by.startsWith("manual")
          ? "manual"
          : null
      : null;
    result[s] = {
      fetching: !excluded,
      failures24h: getFailureCount(s),
      lastFetch: lastFetchAt[s]?.toISOString() ?? null,
      state: liveFetchStates[s] ?? "unknown",

      excluded,
      paused: excluded,
      excludedReason,
      excludedBy: excludedRow?.by ?? null,
      excludedAt: excludedRow?.createdAt.toISOString() ?? null,
      reason: excludedRow?.reason ?? null,
      lastKnownAtExclusion: excludedRow?.statsAtExclusion ?? null,
    };
  }
  return result;
}

/**
 * Fetch one 1m candle from a single source. Short-circuits when the formula
 * excludes the source — excluded adapters are never called.
 */
async function fetchOne(source: string, minuteTs: Date): Promise<SourceResult> {
  if (getCurrentFormula().excludedSources.includes(source)) {
    return { source, candle: null, error: "formula-excluded" };
  }
  const adapter = ADAPTER_BY_NAME[source];
  if (!adapter) return { source, candle: null, error: "unknown source" };

  const t0 = Date.now();
  try {
    const candle = await adapter.fetchOne(minuteTs);
    lastFetchAt[source] = new Date();
    recordLiveFetchState(source, "on");
    return { source, candle, durationMs: Date.now() - t0 };
  } catch (err) {
    recordFailure(source);
    await checkAutoSuspend(source);
    recordLiveFetchState(source, "error");
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
    const results = await Promise.all(ADAPTERS.map((a) => fetchOne(a.name, minuteTs)));

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

    // Helper: write per-source rows with a given usedInFormula verdict. Called
    // on every exit path so the archive captures what each exchange said,
    // regardless of whether a composite landed.
    const writeSourceRows = async (composed: boolean) => {
      for (const g of guarded) {
        if (!g.candle) continue;
        await upsertSourceCandle({
          timestamp: minuteTs, source: g.source, ...g.candle,
          rejected: g.rejected, rejectedReason: g.rejectedReason,
          usedInFormula: composed ? !g.rejected : null,
        });
      }
    };

    let composite;
    try {
      composite = await buildComposite(guarded, baseline, volumeLeader ?? undefined, minuteTs);
    } catch (err) {
      // All sources rejected — no composite, but the archive still gets the raw rows.
      logError("[collector] buildComposite failed:", err);
      await writeSourceRows(/*composed=*/false);
      return false;
    }

    if (Date.now() > deadline) {
      logError(`[collector] deadline exceeded after composite for ${minuteTs.toISOString()} — skipping write`);
      await recordError("collector", "deadline", `Deadline exceeded after composite for ${minuteTs.toISOString()}`);
      await writeSourceRows(/*composed=*/false);
      return false;
    }

    await upsertCandle({ timestamp: minuteTs, ...composite });
    // Per-source writes follow the composite write so the invariant
    // (usedInFormula IS NULL ⟺ no candles_1m row) is restored as soon as both
    // settle. Transactional wrap of the two writes is deferred to Phase 5;
    // current behavior leaves a sub-ms window between them.
    await writeSourceRows(/*composed=*/true);

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
