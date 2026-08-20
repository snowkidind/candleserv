/**
 * Formula model — current state of which exchanges are excluded from composite,
 * derived from an append-only log of per-exchange set/unset events.
 *
 * The `formula_changes` table is the storage. The in-memory mirror is the
 * hot-path read (no DB roundtrip per compose tick). Both stay in sync via the
 * mutation helpers below — never write to formula_changes directly.
 */
import { query } from "./pool.js";
import { recordAdminAction } from "./adminActions.js";
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

// The per-source 24h failure record and the auto-ban suspended set live in the
// Redis overlay (lib/redis.ts) — they are ephemeral, global, live-collector-only
// liveness state, not durable formula intent. formula_changes holds ONLY the
// operator's GLOBAL kill-switch; auto-bans never land here.

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
 * This is the GLOBAL operator kill-switch only — auto-bans live in the Redis
 * overlay (lib/redis.ts) and are cleared there, not here.
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
  // No prior row for this exchange ≡ "included" (the default). Treat that as
  // if the effective current state is "unset" so a redundant unset request
  // (e.g., legacy POST /sources/:source/resume on a source that was never
  // excluded) doesn't write a useless row.
  const effective = current?.setOrUnset ?? "unset";
  if (effective === setOrUnset) {
    return { inserted: false, row: current ?? null };
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

  // Audit: every realized formula change is an admin action (operator edits and
  // auto-suspend alike). Fire-and-forget — recordAdminAction never throws.
  void recordAdminAction({
    actor: by,
    action: setOrUnset === "set" ? "formula.exclude" : "formula.include",
    target: exchange,
    detail: { reason: reason ?? null, statsAtExclusion: stats },
  });

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
