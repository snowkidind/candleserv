import { query } from "../db/pool.js";
import { logError } from "./log.js";

/**
 * How far back a repair job is allowed to reach, in days.
 *
 * Operator-configurable via the `repairHorizonDays` app_setting (set from the
 * sysadmin CLI). Defaults to 180 — the original hard-coded retention horizon,
 * and the floor at which the per-venue SOURCE archive is still pruned
 * (candles.ts/pruneSourceCandles, stableRates.ts/pruneOldStableRates).
 *
 * Decoupled from the prune horizon on purpose: a repair reaching beyond 180d
 * re-fetches that window from the exchange (ensureSourceCoverage hits the live
 * adapters, not retained source rows), recomposes the composite candles_1m
 * (kept forever), and the re-fetched SOURCE rows are pruned again on the next
 * daily cycle. So raising this lets an operator do a one-off deep backfill
 * without growing the source archive unbounded.
 *
 * IMPORTANT — read CACHE-FREE: the value is written by the sysadmin CLI in a
 * SEPARATE process (scripts/repairHorizon.ts), so the server's 1h getSetting
 * cache would not observe a fresh value and would silently clamp a legitimate
 * deep backfill — exactly the silent failure this codebase forbids. Repair is a
 * rare, operator-driven operation, so a direct DB read per call is the right
 * trade. On DB error we log loudly and fall back to the conservative 180d
 * default rather than widening the guard.
 */
export const REPAIR_HORIZON_SETTING_KEY = "repairHorizonDays";
export const REPAIR_HORIZON_DEFAULT_DAYS = 180;

export async function getRepairHorizonDays(): Promise<number> {
  try {
    const res = await query(`SELECT value FROM app_settings WHERE key = $1`, [REPAIR_HORIZON_SETTING_KEY]);
    if (!res.rows.length) return REPAIR_HORIZON_DEFAULT_DAYS;
    const n = parseInt(res.rows[0].value as string, 10);
    return Number.isFinite(n) && n > 0 ? n : REPAIR_HORIZON_DEFAULT_DAYS;
  } catch (err) {
    logError("[retention] getRepairHorizonDays failed — falling back to default:", err);
    return REPAIR_HORIZON_DEFAULT_DAYS;
  }
}

export async function getRepairHorizonMs(): Promise<number> {
  return (await getRepairHorizonDays()) * 24 * 60 * 60 * 1000;
}
