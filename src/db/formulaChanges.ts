/**
 * Formula model — current state of which exchanges are excluded from composite,
 * derived from an append-only log of per-exchange set/unset events.
 *
 * The `formula_changes` table is the storage. The in-memory mirror is the
 * hot-path read (no DB roundtrip per compose tick). Both stay in sync via the
 * mutation helpers below — never write to formula_changes directly.
 *
 * See plan: candleserv-exchange-expansion §Phase 3.
 */
import { query } from "./pool.js";
import { candleEmitter } from "../lib/emitter.js";
import { insertStreamEvent } from "./streamEvents.js";
import { log, logWarn } from "../lib/log.js";

export interface Formula {
  excludedSources: string[];
}

export interface StatsAtExclusion {
  failures24h: number | null;
  outlierRate24h: number | null;
  usedRate24h: number | null;
}

export interface FormulaChange {
  exchange: string;
  setOrUnset: "set" | "unset";
  by: string;
  reason: string | null;
  statsAtExclusion: StatsAtExclusion | null;
  createdAt: Date;
}

// In-memory mirror — latest formula_changes row per exchange. getCurrentFormula
// reads from here; the table is touched only on mutation.
const mirror = new Map<string, FormulaChange>();
let lastChange: FormulaChange | null = null;

// Per-source 24h failure counters. Lives here (not in collector) because the
// failure-counter reset is bundled into insertFormulaChange for 'unset'
// transitions — that's the only way to guarantee a re-included source doesn't
// carry stale failures and immediately re-trip auto-suspend.
const failureCounters: Record<string, number[]> = {};

export function recordFailure(source: string): void {
  const now = Date.now();
  const list = failureCounters[source] ?? [];
  // Drop failures older than 24h, then append.
  failureCounters[source] = list.filter((t) => now - t < 24 * 60 * 60 * 1000);
  failureCounters[source].push(now);
}

export function getFailureCount(source: string): number {
  const now = Date.now();
  const list = failureCounters[source] ?? [];
  // Recompute the 24h window on read so callers don't need to call recordFailure
  // first; this also keeps getSourceStatus consistent.
  return list.filter((t) => now - t < 24 * 60 * 60 * 1000).length;
}

/**
 * Hydrate the in-memory mirror from formula_changes on boot. Reads the latest
 * row per exchange via DISTINCT ON and populates the mirror plus the lastChange
 * cursor. Boot is blocked on this — no degraded mode.
 */
export async function loadFormulaIntoMemory(): Promise<void> {
  const latest = await query(
    `SELECT DISTINCT ON (exchange)
            exchange, "setOrUnset", "by", reason, "statsAtExclusion", "createdAt"
       FROM formula_changes
      ORDER BY exchange, "createdAt" DESC`,
  );
  mirror.clear();
  for (const row of latest.rows) {
    mirror.set(row.exchange, {
      exchange: row.exchange,
      setOrUnset: row.setOrUnset,
      by: row.by,
      reason: row.reason,
      statsAtExclusion: row.statsAtExclusion,
      createdAt: new Date(row.createdAt),
    });
  }

  const recent = await query(
    `SELECT exchange, "setOrUnset", "by", reason, "statsAtExclusion", "createdAt"
       FROM formula_changes
      ORDER BY "createdAt" DESC
      LIMIT 1`,
  );
  lastChange = recent.rows.length
    ? {
        exchange: recent.rows[0].exchange,
        setOrUnset: recent.rows[0].setOrUnset,
        by: recent.rows[0].by,
        reason: recent.rows[0].reason,
        statsAtExclusion: recent.rows[0].statsAtExclusion,
        createdAt: new Date(recent.rows[0].createdAt),
      }
    : null;

  log(`[formula] loaded mirror: ${mirror.size} exchange(s) tracked, ${getCurrentFormula().excludedSources.length} excluded`);
}

/** Hot-path read. No DB I/O. */
export function getCurrentFormula(): Formula {
  const excluded: string[] = [];
  for (const [exchange, row] of mirror) {
    if (row.setOrUnset === "set") excluded.push(exchange);
  }
  return { excludedSources: excluded };
}

export function getLastChange(): FormulaChange | null {
  return lastChange;
}

/** Returns the latest mirror row for the given exchange, or null. */
export function getExchangeState(exchange: string): FormulaChange | null {
  return mirror.get(exchange) ?? null;
}

/**
 * Append a single formula_changes row and update the mirror. Idempotent: if
 * the target state already matches what the mirror says, no INSERT happens.
 *
 * On 'unset' transitions the failure counter for the exchange is cleared so a
 * just-re-included source doesn't carry stale 24h failures and re-trip
 * auto-suspend on the next hiccup. The reset is here (not in callers) so it
 * can't be forgotten.
 *
 * Emits source_state on actual transitions: 'formula-excluded' on set,
 * 'formula-included' on unset. No emission on idempotent no-ops.
 */
export async function insertFormulaChange(
  exchange: string,
  setOrUnset: "set" | "unset",
  by: string,
  reason?: string | null,
  statsAtExclusion?: StatsAtExclusion | null,
): Promise<{ inserted: boolean; row: FormulaChange | null }> {
  const current = mirror.get(exchange);
  if (current && current.setOrUnset === setOrUnset) {
    // Already in the requested state — skip the insert.
    return { inserted: false, row: current };
  }

  const stats = setOrUnset === "set" ? (statsAtExclusion ?? null) : null;
  const res = await query(
    `INSERT INTO formula_changes ("exchange","setOrUnset","by","reason","statsAtExclusion")
     VALUES ($1,$2,$3,$4,$5)
     RETURNING "createdAt"`,
    [exchange, setOrUnset, by, reason ?? null, stats ? JSON.stringify(stats) : null],
  );

  const row: FormulaChange = {
    exchange,
    setOrUnset,
    by,
    reason: reason ?? null,
    statsAtExclusion: stats,
    createdAt: new Date(res.rows[0].createdAt),
  };

  mirror.set(exchange, row);
  lastChange = row;

  if (setOrUnset === "unset") {
    // Re-include: wipe the 24h failure counter so old failures can't immediately
    // re-trip auto-suspend.
    failureCounters[exchange] = [];
  }

  const sseState = setOrUnset === "set" ? "formula-excluded" : "formula-included";
  candleEmitter.emit("source_state", {
    source: exchange,
    state: sseState,
    previousState: current?.setOrUnset === "set" ? "formula-excluded" : "formula-included",
    by,
    reason: reason ?? null,
    timestamp: row.createdAt.getTime(),
  });
  try {
    await insertStreamEvent(exchange, sseState);
  } catch (err) {
    logWarn(`[formula] failed to persist stream event for ${exchange}: ${err}`);
  }

  log(`[formula] ${exchange} ${setOrUnset} by ${by}${reason ? ` (${reason})` : ""}`);
  return { inserted: true, row };
}

/**
 * Compute the diff between desired and current formula, then insert one
 * formula_changes row per transition. Returns the rows that were actually
 * inserted (excludes idempotent no-ops).
 *
 * For 'set' transitions, caller can pass a statsAtExclusion snapshot via the
 * statsAtExclusion option — applied to every newly-excluded source uniformly.
 * Use case: the operator PUT handler snapshots once before computing the diff.
 */
export async function applyFormulaDelta(
  desired: Formula,
  by: string,
  reason?: string | null,
  statsAtExclusion?: StatsAtExclusion | null,
): Promise<{ inserted: FormulaChange[] }> {
  const current = new Set(getCurrentFormula().excludedSources);
  const target = new Set(desired.excludedSources);

  const toSet: string[] = [];
  const toUnset: string[] = [];
  for (const e of target) if (!current.has(e)) toSet.push(e);
  for (const e of current) if (!target.has(e)) toUnset.push(e);

  const inserted: FormulaChange[] = [];
  for (const exchange of toSet) {
    const r = await insertFormulaChange(exchange, "set", by, reason, statsAtExclusion);
    if (r.inserted && r.row) inserted.push(r.row);
  }
  for (const exchange of toUnset) {
    const r = await insertFormulaChange(exchange, "unset", by, reason);
    if (r.inserted && r.row) inserted.push(r.row);
  }

  return { inserted };
}
