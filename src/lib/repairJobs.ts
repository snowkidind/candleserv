/**
 * Repair-job state machine — Phase 5c of the exchange-expansion plan.
 *
 * In-memory only (per the plan's resolved decision #7): a Map<jobId, state>
 * plus a `repairInProgress` single-flight flag. Server restart during a
 * running job means the job dies; the operator re-runs.
 *
 * State machine: queued → ensuring → backfilling → recomposing → done | failed | cancelled.
 * (backfilling = stable-rate backfill per Phase 5 of the stablecoin-aware index plan.)
 *
 * Single-flight: only one job at a time. Auto-suspend formula edits and
 * operator PUT /monitor/formula still work during a repair (the formula is
 * snapshotted at job start, so mid-run edits don't affect the in-flight
 * compose verdict).
 */
import crypto from "node:crypto";
import { ensureSourceCoverage, recomposeRange } from "./repair.js";
import type { EnsureSourceCoverageResult, RecomposeRangeResult } from "./repair.js";
import { backfillStableRates } from "./stableRateBackfill.js";
import type { BackfillStableRatesResult } from "./stableRateBackfill.js";
import { resolveRepairSources } from "../db/formulaVersions.js";
import { closeAllListeners } from "./emitter.js";
import { redisDelByPrefix } from "./redis.js";
import { getRepairHorizonDays } from "./retention.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";

export interface Formula {
  excludedSources: string[];
}

/**
 * Step SELECTION — which of the three independently-runnable units a repair job
 * runs (any non-empty subset). Distinct axis from the progress state below:
 *   fetch     → ensureSourceCoverage (token archive)
 *   stables   → backfillStableRates  (shared USDT→USD pegs)
 *   recompose → recomposeRange       (re-derive the composite; no fetches)
 * Recompose-only = ["recompose"].
 */
export type RepairStep = "fetch" | "stables" | "recompose";
export const ALL_REPAIR_STEPS: RepairStep[] = ["fetch", "stables", "recompose"];

/**
 * Progress STATE — where the job is right now. The in-flight states read in the
 * step vocabulary the UI shows (fetching / stables / recomposing). Different
 * concern from the step SELECTION above (RepairStep): a job that only runs
 * ["recompose"] transitions queued → recomposing → done.
 */
export type RepairJobStep =
  | "queued"
  | "fetching"
  | "stables"
  | "recomposing"
  | "done"
  | "failed"
  | "cancelled";

export interface RepairJobState {
  jobId: string;
  state: RepairJobStep;
  startedAt: string;          // ISO
  finishedAt: string | null;  // ISO when terminal, null otherwise

  // Original request — snapshot taken at job start.
  currency: string;
  from: string;
  to: string;
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;
  repairExistingTokenMinutes?: boolean;  // Stage 6: ON → re-fetch + overwrite token archive (else fill holes only)
  repairExistingStableMinutes?: boolean; // Stage 6: ON → re-fetch + overwrite pegs (else fill holes only)
  steps: RepairStep[];        // which units this job runs (subset of ALL_REPAIR_STEPS)
  suspendGlobal?: boolean;    // true → blocked ALL candle reads during the repair (shared pegs)

  // Per-step results — populated as steps complete (null if the step wasn't run).
  ensure: EnsureSourceCoverageResult | null;
  backfill: BackfillStableRatesResult | null;
  recompose: RecomposeRangeResult | null;

  // Final outcome.
  result?: { rowsWritten: number; archiveRowsFetched: number };
  error?: string;
}

interface JobEntry {
  state: RepairJobState;
  controller: AbortController;
}

const jobs = new Map<string, JobEntry>();
// Per-currency lock (Stage 4): the set of currencies with an in-progress repair.
// Single-flight is now PER CURRENCY — a TON repair no longer blocks a BTC read,
// and a BTC repair can run while TON repairs. `globalSuspendCount` > 0 means a
// repair asked to block ALL candle reads (stable-rate repairs, since pegs are
// shared across currencies); a counter, not a bool, so overlapping global
// suspends compose correctly.
const repairingCurrencies = new Set<string>();
let globalSuspendCount = 0;

/** Is the given currency mid-repair? Used by the per-currency repair lock. */
export function isCurrencyRepairing(currency: string): boolean {
  return repairingCurrencies.has(currency);
}

/** Is a global-suspend repair running (block ALL candle reads)? */
export function isGlobalRepairSuspend(): boolean {
  return globalSuspendCount > 0;
}

/**
 * Any repair in any non-terminal state? Retained for status/recovery callers.
 * The repair LOCK no longer uses this — it gates per-currency (see repairLock).
 */
export function isRepairInProgress(): boolean {
  return repairingCurrencies.size > 0 || globalSuspendCount > 0;
}

export function getRepairJob(jobId: string): RepairJobState | null {
  return jobs.get(jobId)?.state ?? null;
}

/**
 * Returns the currently-running job's state (any non-terminal state), or null.
 * Used by the frontend on mount to recover from a tab-navigation away/back —
 * the server's single-flight flag is authoritative, the client just needs the
 * jobId to resume polling.
 */
export function getActiveRepairJob(): RepairJobState | null {
  if (repairingCurrencies.size === 0 && globalSuspendCount === 0) return null;
  for (const { state } of jobs.values()) {
    if (state.state !== "done" && state.state !== "failed" && state.state !== "cancelled") {
      return state;
    }
  }
  return null;
}

export function cancelRepairJob(jobId: string): { ok: boolean; error?: string } {
  const entry = jobs.get(jobId);
  if (!entry) return { ok: false, error: "unknown jobId" };
  const terminal = entry.state.state === "done" || entry.state.state === "failed" || entry.state.state === "cancelled";
  if (terminal) return { ok: false, error: `job already ${entry.state.state}` };
  entry.controller.abort();
  log(`[repair-job] ${jobId} cancel requested`);
  return { ok: true };
}

export interface StartRepairJobRequest {
  currency: string;
  from: Date;
  to: Date;
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;
  repairExistingTokenMinutes?: boolean; // Stage 6 token toggle
  repairExistingStableMinutes?: boolean; // Stage 6 stable toggle
  steps?: RepairStep[];   // default: all three (today's full ensure→backfill→recompose chain)
  suspendGlobal?: boolean; // block ALL candle reads during the repair (stable-rate repairs — pegs are shared)
}

export function startRepairJob(req: StartRepairJobRequest): { jobId: string } {
  // Per-currency single-flight: a second repair for the SAME currency is rejected,
  // but different currencies may repair concurrently (the per-venue rate gate
  // serializes same-venue calls across jobs).
  if (repairingCurrencies.has(req.currency)) {
    throw new Error(`a repair job is already in progress for ${req.currency}`);
  }
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  const steps = req.steps ?? ALL_REPAIR_STEPS;
  const suspendGlobal = req.suspendGlobal ?? false;
  const state: RepairJobState = {
    jobId,
    state: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currency:   req.currency,
    from: req.from.toISOString(),
    to:   req.to.toISOString(),
    sources:    req.sources,
    formula:    req.formula,
    retryEmpty: req.retryEmpty,
    repairExistingTokenMinutes:  req.repairExistingTokenMinutes,
    repairExistingStableMinutes: req.repairExistingStableMinutes,
    steps,
    suspendGlobal,
    ensure:    null,
    backfill:  null,
    recompose: null,
  };
  jobs.set(jobId, { state, controller });
  repairingCurrencies.add(req.currency);
  if (suspendGlobal) globalSuspendCount++;

  // Drain in-flight long-poll waitForFresh subscribers and SSE consumers BEFORE
  // the job starts. New requests will be 503'd by repairLock middleware; this
  // closes the gap for connections that were already past middleware.
  closeAllListeners("repair in progress");

  // Fire-and-forget the work loop; errors are captured in state.error.
  void runRepairJob(jobId, controller).catch((err) => {
    // Should be unreachable — runRepairJob has its own catch.
    logError(`[repair-job] ${jobId} fatal uncaught:`, err);
  });

  log(`[repair-job] ${jobId} started: ${state.currency} ${state.from} → ${state.to} steps=[${steps.join(",")}]${suspendGlobal ? " suspendGlobal" : ""}${req.formula ? ` formula-override=${JSON.stringify(req.formula.excludedSources)}` : ""}`);
  return { jobId };
}

async function runRepairJob(jobId: string, controller: AbortController): Promise<void> {
  const entry = jobs.get(jobId);
  if (!entry) return;
  const { state } = entry;
  const { steps } = state;

  // Each step is independently selectable (any subset of fetch/stables/recompose).
  // The stables and recompose steps act on whatever archive is already present —
  // a stables-only or recompose-only run is valid and must NOT assume the fetch
  // step ran first. backfillStableRates' WHERE-EXISTS guard keeps a stables run
  // without a preceding fetch FK-safe.
  const cancelledAfter = (stepLabel: string): boolean => {
    if (!controller.signal.aborted) return false;
    state.state = "cancelled";
    state.finishedAt = new Date().toISOString();
    log(`[repair-job] ${jobId} cancelled after ${stepLabel} step`);
    return true;
  };

  try {
    // Step: fetch — ensureSourceCoverage (token archive).
    if (steps.includes("fetch")) {
      state.state = "fetching";
      state.ensure = await ensureSourceCoverage(
        state.currency,
        new Date(state.from),
        new Date(state.to),
        {
          sources: state.sources,
          retryEmpty: state.retryEmpty,
          // Stage 6: token toggle ON (or legacy retryEmpty) → re-fetch + overwrite.
          overwriteExisting: state.repairExistingTokenMinutes || state.retryEmpty,
          signal: controller.signal,
        },
      );
      if (cancelledAfter("fetch")) return;
    }

    // Step: stables — backfillStableRates (shared USDT→USD pegs). FK-safe via its
    // own WHERE-EXISTS guard, so it's valid even without a preceding fetch step.
    if (steps.includes("stables")) {
      state.state = "stables";
      state.backfill = await backfillStableRates(
        new Date(state.from),
        new Date(state.to),
        {
          sources: state.sources,
          currency: state.currency,
          // Stage 6: stable toggle ON (or legacy retryEmpty) → re-fetch + overwrite pegs.
          retryEmpty: state.repairExistingStableMinutes || state.retryEmpty,
          signal: controller.signal,
        },
      );
      if (cancelledAfter("stables")) return;
    }

    // Step: recompose — recomposeRange (re-derive the composite; pure DB, no fetch).
    if (steps.includes("recompose")) {
      state.state = "recomposing";
      state.recompose = await recomposeRange(
        state.currency,
        new Date(state.from),
        new Date(state.to),
        {
          formula: state.formula,
          signal: controller.signal,
        },
      );
      if (cancelledAfter("recompose")) return;
    }

    // Done.
    state.state = "done";
    state.result = {
      rowsWritten: state.recompose?.recomposed ?? 0,
      archiveRowsFetched: state.ensure?.rowsFetched ?? 0,
    };
    state.finishedAt = new Date().toISOString();
    log(`[repair-job] ${jobId} done [${steps.join(",")}]: ${state.recompose?.recomposed ?? 0} rows recomposed, ${state.ensure?.rowsFetched ?? 0} archive rows fetched, ${state.backfill?.rowsInserted ?? 0} stable rates filled`);
  } catch (err) {
    state.state = "failed";
    state.error = String(err);
    state.finishedAt = new Date().toISOString();
    logError(`[repair-job] ${jobId} failed:`, err);
  } finally {
    // Flush the candles Redis cache regardless of outcome. recomposeRange may
    // have partially rewritten candles_1m even when the overall job ended in
    // failed/cancelled; cache entries are read-through optimizations, so
    // dropping them costs only a few extra DB queries on the next request.
    const flushed = await redisDelByPrefix("candles:");
    if (flushed > 0) log(`[repair-job] ${jobId} cache flushed (${flushed} keys)`);
    repairingCurrencies.delete(state.currency);
    if (state.suspendGlobal) globalSuspendCount = Math.max(0, globalSuspendCount - 1);
  }
}

// ── Preview / dry-run ────────────────────────────────────────────────────────

export interface RepairPreview {
  compositeRowsInWindow: number;
  willBeRecomposed: number;
  archiveHoles: number;
  missingBySource: Record<string, number>;
  sentinelsToRetry: number;
  estimatedWallMs: number;
  liveFormulaUnchanged: boolean;
}

/**
 * Dry-run preview — counts archive holes, composite rows in window, etc.
 * Pure DB reads, no exchange fetches.
 */
export async function previewRepair(req: StartRepairJobRequest): Promise<RepairPreview> {
  const { currency, from, to, sources, formula, retryEmpty } = req;
  const steps = req.steps ?? ALL_REPAIR_STEPS;

  // Every count is scoped to the requested currency so the preview matches what
  // the fetch/recompose steps (which only touch that currency) will do.
  // 1. How many candles_1m rows live in the window?
  const compRes = await query(
    `SELECT COUNT(*) AS n FROM candles_1m WHERE currency = $3 AND timestamp >= $1 AND timestamp < $2`,
    [from, to, currency],
  );
  const compositeRowsInWindow = Number(compRes.rows[0]?.n ?? 0);

  // 2. Total minutes in the window. willBeRecomposed = the count of minutes
  // recomposeRange will visit. recomposeRange walks every minute in the range
  // and either recomposes (composes successfully) or skips. We report total
  // minutes here; the result.recomposed count tells the operator what actually
  // landed.
  const totalMinutes = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000));
  const willBeRecomposed = totalMinutes;

  // 3. Archive holes — how many (minute, source) pairs are missing in the
  // window. The denominator is the repair's ACTUAL fetch set (Stage 4): the
  // per-op allow-list or the per-currency formula timeline union — NOT
  // getActiveFeeds, so the preview doesn't count holes for venues the repair
  // won't fetch (the coinbase/gate no_data waste). Excludes 'no_data' sentinels
  // unless retryEmpty.
  const requestedSources = sources ?? await resolveRepairSources(currency, from, to);

  const sentinelsRes = await query(
    `SELECT COUNT(*) AS n FROM candles_1m_sources
      WHERE "currency" = $3
        AND timestamp >= $1 AND timestamp < $2
        AND "rejectedReason" = 'no_data'`,
    [from, to, currency],
  );
  const sentinelsToRetry = retryEmpty ? Number(sentinelsRes.rows[0]?.n ?? 0) : 0;

  // Count existing rows per source in the window — what's there counts toward
  // "not a hole." If retryEmpty, exclude 'no_data' sentinels from "existing"
  // since they'll be deleted and re-fetched.
  const existingClause = retryEmpty
    ? `AND COALESCE("rejectedReason",'') <> 'no_data'`
    : ``;
  const perSourceRes = await query(
    `SELECT source, COUNT(*) AS n FROM candles_1m_sources
      WHERE "currency" = $3
        AND timestamp >= $1 AND timestamp < $2 ${existingClause}
      GROUP BY source`,
    [from, to, currency],
  );
  const existingBySource: Record<string, number> = {};
  for (const r of perSourceRes.rows) {
    existingBySource[r.source as string] = Number(r.n);
  }

  const missingBySource: Record<string, number> = {};
  let archiveHoles = 0;
  for (const s of requestedSources) {
    const have = existingBySource[s] ?? 0;
    const missing = Math.max(0, totalMinutes - have);
    missingBySource[s] = missing;
    archiveHoles += missing;
  }

  // 4. Rough wall-time estimate. ensureSourceCoverage walks tiles backward
  // with a 5s throttle between tiles. Tile size = 300 minutes. So tile count
  // = ceil(totalMinutes / 300), and the fetch step ≈ tileCount * (5s + per-tile
  // HTTP time ≈ 2s) for the fastest-resolving source. The recompose step is
  // ~1ms per minute (pure DB), so totalMinutes * 1ms.
  // Only count the steps this run will actually perform — a recompose-only run
  // pays no fetch-step throttle.
  const tileCount = Math.ceil(totalMinutes / 300);
  const ensureMs = steps.includes("fetch") ? tileCount * 7000 : 0;
  const recomposeMs = steps.includes("recompose") ? totalMinutes * 1 : 0;
  const estimatedWallMs = ensureMs + recomposeMs;

  // 5. Live-formula-unchanged is always true — repair never writes to
  // formula_changes. The preview returns it as an affordance for the UI.
  const liveFormulaUnchanged = true;

  return {
    compositeRowsInWindow,
    willBeRecomposed,
    archiveHoles,
    missingBySource,
    sentinelsToRetry,
    estimatedWallMs,
    liveFormulaUnchanged,
  };
}

// ── Retention / window guards ────────────────────────────────────────────────

/**
 * Validate the [from, to) window against the two hard rules:
 *   - from ≥ NOW() - repairHorizonDays   (operator-configurable; default 180d)
 *   - to   ≤ floor(NOW() to minute) - 1 minute   (most recently closed minute)
 *
 * Returns null on success or a human-readable error on failure. Async because
 * the horizon is read cache-free from app_settings (see retention.ts). Used by
 * the REST handler before invoking startRepairJob / previewRepair.
 */
export async function validateRepairWindow(from: Date, to: Date): Promise<string | null> {
  if (!(from instanceof Date) || isNaN(from.getTime())) return "from must be a valid ISO timestamp";
  if (!(to instanceof Date)   || isNaN(to.getTime()))   return "to must be a valid ISO timestamp";
  if (to.getTime() <= from.getTime()) return "to must be strictly after from";

  const horizonDays = await getRepairHorizonDays();
  const retentionHorizon = new Date(Date.now() - horizonDays * 24 * 60 * 60 * 1000);
  if (from < retentionHorizon) {
    return `from is older than the ${horizonDays}-day repair horizon (${retentionHorizon.toISOString()})`;
  }

  // Most recently closed minute = floor(NOW() to minute) - 1 minute boundary.
  // i.e., to.getTime() must be at-or-before the start of the current minute.
  const currentMinuteStart = Math.floor(Date.now() / 60000) * 60000;
  if (to.getTime() > currentMinuteStart) {
    return `to is at or after the current in-progress minute (${new Date(currentMinuteStart).toISOString()})`;
  }
  return null;
}
