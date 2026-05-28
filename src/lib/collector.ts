import { ADAPTERS, ADAPTER_BY_NAME, SOURCE_NAMES, type Adapter } from "../adapters/registry.js";
import { symbolFor } from "../adapters/symbolMap.js";
import { applyGuards } from "./composite.js";
import { composeMinute } from "./compose.js";
import { getSourceCountBaseline, getRecentCloseStddev, getTrailingVolumeLeader, get24hSourceStats } from "../db/candles.js";
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
import { withTransaction } from "../db/pool.js";
import { log, logError, logWarn } from "./log.js";
import type { SourceCandle, SourceResult } from "../types/index.js";

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
 * Per-venue bundle: the BTC candle and the venue's local USDT/USD rate are a
 * single observation. Either both halves succeed and persist, or the venue
 * fails for that minute. See plan: candleserv-stablecoin-aware-index §Phase 1.
 */
interface VenueBundle {
  source: string;
  candle: SourceCandle | null;
  rate: number | null;            // null when adapter.normalize.pegFetcher is null (USD-native)
  pegSourcePair: string | null;   // provenance for the stable rate row
  error?: string;
  durationMs?: number;
}

/**
 * Fetch one venue's BTC candle + local stable rate as an atomic bundle.
 * Short-circuits when the formula excludes the source.
 *
 * Preserves the operational side-effects of the prior `fetchOne` exactly:
 *   - on bundle success → lastFetchAt[source] = now + recordLiveFetchState("on")
 *   - on bundle failure (either half) → recordLiveFetchState("error")
 *     plus recordFailure / checkAutoSuspend
 * The venue is the atomic unit of observation; a half-failed bundle is a
 * venue-level error and the operational UI's status dot reflects that.
 */
async function fetchVenueBundle(adapter: Adapter, minuteTs: Date): Promise<VenueBundle> {
  if (getCurrentFormula().excludedSources.includes(adapter.name)) {
    return { source: adapter.name, candle: null, rate: null, pegSourcePair: null, error: "formula-excluded" };
  }

  const t0 = Date.now();
  try {
    const [candle, rate] = await Promise.all([
      adapter.fetchOne(symbolFor("BTC", adapter.name), minuteTs),
      adapter.normalize.pegFetcher
        ? adapter.normalize.pegFetcher(minuteTs)
        : Promise.resolve(null),
    ]);
    lastFetchAt[adapter.name] = new Date();
    recordLiveFetchState(adapter.name, "on");
    return {
      source: adapter.name,
      candle,
      rate,
      pegSourcePair: adapter.normalize.pegSourcePair,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    recordFailure(adapter.name);
    await checkAutoSuspend(adapter.name);
    recordLiveFetchState(adapter.name, "error");
    await recordError("collector", `fetchVenueBundle:${adapter.name}`, String(err));
    return {
      source: adapter.name,
      candle: null,
      rate: null,
      pegSourcePair: null,
      error: String(err),
      durationMs: Date.now() - t0,
    };
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
    const bundles = await Promise.all(ADAPTERS.map((a) => fetchVenueBundle(a, minuteTs)));

    if (Date.now() > deadline) {
      const timings = bundles.map(b => `${b.source}:${b.durationMs ?? "?"}ms`).join(" ");
      logError(`[collector] deadline exceeded for ${minuteTs.toISOString()} — ${timings}`);
      await recordError("collector", "deadline", `Deadline exceeded for ${minuteTs.toISOString()} — ${timings}`);
      return false;
    }

    const minSources   = await getSettingInt("minSources", 3);
    const baseline     = await getSourceCountBaseline();
    const sigma        = await getRecentCloseStddev();
    const volumeLeader = await getTrailingVolumeLeader(10);
    // applyGuards consumes the BTC half of each bundle; the rate half is
    // carried alongside via the per-source map below.
    const results: SourceResult[] = bundles.map((b) => ({
      source: b.source,
      candle: b.candle,
      ...(b.error ? { error: b.error } : {}),
      ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
    }));
    const ratesBySource = new Map<string, { rate: number; pegSourcePair: string }>();
    for (const b of bundles) {
      if (b.rate !== null && b.pegSourcePair !== null) {
        ratesBySource.set(b.source, { rate: b.rate, pegSourcePair: b.pegSourcePair });
      }
    }
    const guarded = applyGuards(results, minSources, sigma);

    // Step 1: write every fetched source's BTC row + its paired stable rate
    // row in a single transaction. The FK on stable_rates_1m_sources requires
    // the BTC row to be inserted first; both inserts run on the same
    // connection so the constraint is satisfied at commit. Rate row persists
    // whenever the rate fetch succeeded — including when the BTC row was
    // outlier-rejected. See plan §Phase 1 "On guard-rejection semantics for
    // the rate row." usedInFormula is left NULL — composeMinute bulk-updates
    // it.
    await withTransaction(async (client) => {
      for (const g of guarded) {
        if (!g.candle) continue;
        // Inline the BTC insert directly here — do NOT call upsertSourceCandle
        // (it acquires its own pool connection and would break atomicity).
        await client.query(
          `INSERT INTO candles_1m_sources
             ("timestamp","source","open","high","low","close","volume","rejected","rejectedReason","usedInFormula")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT ("timestamp","source") DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
             volume = EXCLUDED.volume, rejected = EXCLUDED.rejected, "rejectedReason" = EXCLUDED."rejectedReason",
             "usedInFormula" = EXCLUDED."usedInFormula",
             "updatedAt" = NOW()`,
          [minuteTs, g.source, g.candle.open, g.candle.high, g.candle.low, g.candle.close, g.candle.volume,
           g.rejected, g.rejectedReason ?? null, null],
        );
        const rate = ratesBySource.get(g.source);
        if (rate) {
          await client.query(
            `INSERT INTO stable_rates_1m_sources
               ("timestamp","source","rate","pegSourcePair")
             VALUES ($1,$2,$3,$4)
             ON CONFLICT ("timestamp","source") DO UPDATE SET
               rate = EXCLUDED.rate,
               "pegSourcePair" = EXCLUDED."pegSourcePair",
               "updatedAt" = NOW()`,
            [minuteTs, g.source, rate.rate, rate.pegSourcePair],
          );
        }
      }
    });

    if (Date.now() > deadline) {
      logError(`[collector] deadline exceeded after archive writes for ${minuteTs.toISOString()} — skipping compose`);
      await recordError("collector", "deadline", `Deadline exceeded after archive writes for ${minuteTs.toISOString()}`);
      return false;
    }

    // Step 2: composeMinute reads back the archive, applies the live formula,
    // and writes candles_1m + bulk-UPDATEs usedInFormula on every archive row
    // at this timestamp — all in one transaction. The invariant
    // (usedInFormula IS NULL ⟺ no candles_1m row) holds at commit.
    const result = await composeMinute(
      minuteTs,
      getCurrentFormula(),
      { baseline, minSources, volumeLeader: volumeLeader ?? undefined },
    );

    if (!result.composed) {
      logError(`[collector] composeMinute skipped ${minuteTs.toISOString()} — only ${result.contributing} sources after formula+guards (need ${minSources})`);
      return false;
    }

    const composite = result.composite!;
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
