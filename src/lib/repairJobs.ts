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
import { getActiveFeeds } from "../db/currencyFeeds.js";
import { getCurrentFormula } from "../db/formulaChanges.js";
import { closeAllListeners } from "./emitter.js";
import { redisDelByPrefix } from "./redis.js";
import { getRepairHorizonDays } from "./retention.js";
import { query } from "../db/pool.js";
import { log, logError } from "./log.js";

export interface Formula {
  excludedSources: string[];
}

export type RepairJobPhase =
  | "queued"
  | "ensuring"
  | "backfilling"
  | "recomposing"
  | "done"
  | "failed"
  | "cancelled";

export interface RepairJobState {
  jobId: string;
  state: RepairJobPhase;
  startedAt: string;          // ISO
  finishedAt: string | null;  // ISO when terminal, null otherwise

  // Original request — snapshot taken at job start.
  currency: string;
  from: string;
  to: string;
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;

  // Per-phase results — populated as phases complete.
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
let repairInProgress = false;

/**
 * Is a repair job currently in any non-terminal phase? Used by the repair-
 * lock middleware to gate candle-poll endpoints.
 */
export function isRepairInProgress(): boolean {
  return repairInProgress;
}

export function getRepairJob(jobId: string): RepairJobState | null {
  return jobs.get(jobId)?.state ?? null;
}

/**
 * Returns the currently-running job's state (any non-terminal phase), or null.
 * Used by the frontend on mount to recover from a tab-navigation away/back —
 * the server's single-flight flag is authoritative, the client just needs the
 * jobId to resume polling.
 */
export function getActiveRepairJob(): RepairJobState | null {
  if (!repairInProgress) return null;
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
}

export function startRepairJob(req: StartRepairJobRequest): { jobId: string } {
  if (repairInProgress) {
    throw new Error("a repair job is already in progress");
  }
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
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
    ensure:    null,
    backfill:  null,
    recompose: null,
  };
  jobs.set(jobId, { state, controller });
  repairInProgress = true;

  // Drain in-flight long-poll waitForFresh subscribers and SSE consumers BEFORE
  // the job starts. New requests will be 503'd by repairLock middleware; this
  // closes the gap for connections that were already past middleware.
  closeAllListeners("repair in progress");

  // Fire-and-forget the work loop; errors are captured in state.error.
  void runRepairJob(jobId, controller).catch((err) => {
    // Should be unreachable — runRepairJob has its own catch.
    logError(`[repair-job] ${jobId} fatal uncaught:`, err);
  });

  log(`[repair-job] ${jobId} started: ${state.currency} ${state.from} → ${state.to}${req.formula ? ` formula-override=${JSON.stringify(req.formula.excludedSources)}` : ""}`);
  return { jobId };
}

async function runRepairJob(jobId: string, controller: AbortController): Promise<void> {
  const entry = jobs.get(jobId);
  if (!entry) return;
  const { state } = entry;

  try {
    // Phase 1: ensureSourceCoverage.
    state.state = "ensuring";
    const ensure = await ensureSourceCoverage(
      state.currency,
      new Date(state.from),
      new Date(state.to),
      {
        sources: state.sources,
        retryEmpty: state.retryEmpty,
        signal: controller.signal,
      },
    );
    state.ensure = ensure;

    if (controller.signal.aborted) {
      state.state = "cancelled";
      state.finishedAt = new Date().toISOString();
      log(`[repair-job] ${jobId} cancelled after ensure phase`);
      return;
    }

    // Phase 2: backfillStableRates. FK-safe — only inserts rate rows where
    // the BTC row exists, which the ensure phase has just guaranteed.
    state.state = "backfilling";
    const backfill = await backfillStableRates(
      new Date(state.from),
      new Date(state.to),
      {
        sources: state.sources,
        signal: controller.signal,
      },
    );
    state.backfill = backfill;

    if (controller.signal.aborted) {
      state.state = "cancelled";
      state.finishedAt = new Date().toISOString();
      log(`[repair-job] ${jobId} cancelled after backfill phase`);
      return;
    }

    // Phase 3: recomposeRange.
    state.state = "recomposing";
    const recompose = await recomposeRange(
      state.currency,
      new Date(state.from),
      new Date(state.to),
      {
        formula: state.formula,
        signal: controller.signal,
      },
    );
    state.recompose = recompose;

    if (controller.signal.aborted) {
      state.state = "cancelled";
      state.finishedAt = new Date().toISOString();
      log(`[repair-job] ${jobId} cancelled after recompose phase`);
      return;
    }

    // Done.
    state.state = "done";
    state.result = {
      rowsWritten: recompose.recomposed,
      archiveRowsFetched: ensure.rowsFetched,
    };
    state.finishedAt = new Date().toISOString();
    log(`[repair-job] ${jobId} done: ${recompose.recomposed} rows recomposed, ${ensure.rowsFetched} archive rows fetched, ${backfill.rowsInserted} stable rates filled`);
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
    repairInProgress = false;
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

  // Every count is scoped to the requested currency so the preview matches what
  // the ensure/recompose phases (which only touch that currency) will do.
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
  // window. Excludes formula-excluded sources from the denominator (we don't
  // intend to fill those). Excludes 'no_data' sentinels unless retryEmpty.
  // SOURCE_NAMES from the registry is the source of truth so a future 9th
  // adapter gets included in the preview without touching this file.
  const excluded = new Set(getCurrentFormula().excludedSources);
  const restrict = sources ? new Set(sources) : null;
  const requestedSources = (await getActiveFeeds(currency))
    .map((f) => f.source)
    .filter((s) => !excluded.has(s) && (!restrict || restrict.has(s)));

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
  // = ceil(totalMinutes / 300), and ensure-phase ≈ tileCount * (5s + per-tile
  // HTTP time ≈ 2s) for the fastest-resolving source. Recompose-phase is
  // ~1ms per minute (pure DB), so totalMinutes * 1ms.
  const tileCount = Math.ceil(totalMinutes / 300);
  const ensureMs = tileCount * 7000;
  const recomposeMs = totalMinutes * 1;
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
