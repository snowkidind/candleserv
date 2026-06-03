/**
 * Per-currency formula TIMELINE — the effective-dated record of which venues
 * compose a currency over time (candleserv-repair-rework Stage 3, decision D1).
 *
 * Repair, heal, and recompose resolve `formula(currency, minute)` from here: the
 * version with the greatest `effectiveFrom <= minute`. Stored CHANGES-only — one
 * row per breakpoint per currency, each row self-contained (the actual inclusive
 * venue set `{ sources: [...] }`, no delta replay). The head of the timeline is
 * the "current" repair set.
 *
 * Three distinct surfaces by design (do not conflate — see plan §2):
 *   - formula_changes (formulaChanges.ts) ...... GLOBAL operator kill-switch /
 *                                                "alive globally". Live + repair
 *                                                both subtract it.
 *   - currency_sources (currencyFeeds.ts) ...... the LIVE real-time poll set
 *                                                (available ∩ enabled).
 *   - currency_formula_versions (this file) .... the REPAIR/HEAL/RECOMPOSE
 *                                                historical selection, per minute.
 *
 * Auto-bans are NEVER stored here — they are ephemeral live-collector state in
 * Redis (lib/redis.ts) and must never bleed into a historical period.
 */
import { query } from "./pool.js";
import { SOURCE_NAMES } from "../adapters/registry.js";
import { getActiveFeeds } from "./currencyFeeds.js";
import { getCurrentFormula } from "./formulaChanges.js";
import { log, logWarn } from "../lib/log.js";

// All history before any operator breakpoint resolves to the seeded baseline.
// Far enough back to precede any 1m crypto candle.
const SEED_EFFECTIVE_FROM = new Date("2009-01-01T00:00:00Z");

export interface FormulaVersion {
  currency: string;
  effectiveFrom: Date;
  sources: string[];     // inclusive allow-list of venue names
  by: string;
  reason: string | null;
  createdAt: Date;
}

/**
 * The compose math takes a deny-list (`{ excludedSources }`); the timeline stores
 * an inclusive allow-list. Convert here against the full adapter set so the two
 * stay in lockstep (Ground Rule 4 — inclusive model, deny-list wire shape).
 */
export function toExcludedSources(sources: string[]): { excludedSources: string[] } {
  const incl = new Set(sources);
  return { excludedSources: SOURCE_NAMES.filter((s) => !incl.has(s)) };
}

/** Full ascending timeline for a currency (changes-only; usually a handful of rows). */
export async function getFormulaTimeline(currency: string): Promise<FormulaVersion[]> {
  const res = await query(
    `SELECT "currency", "effectiveFrom", "formula", "by", "reason", "createdAt"
       FROM currency_formula_versions
      WHERE "currency" = $1
      ORDER BY "effectiveFrom" ASC`,
    [currency],
  );
  return res.rows.map((r: any) => ({
    currency: r.currency,
    effectiveFrom: new Date(r.effectiveFrom),
    sources: Array.isArray(r.formula?.sources) ? r.formula.sources : [],
    by: r.by,
    reason: r.reason,
    createdAt: new Date(r.createdAt),
  }));
}

/**
 * Insert (or replace) a timeline version. The operator's repair/heal venue pick
 * for a window writes one of these — durable intent, not an ephemeral per-run
 * override. ON CONFLICT updates so a re-pick at the same instant overwrites.
 */
export async function insertFormulaVersion(
  currency: string,
  effectiveFrom: Date,
  sources: string[],
  by: string,
  reason?: string | null,
): Promise<void> {
  const unknown = sources.filter((s) => !SOURCE_NAMES.includes(s));
  if (unknown.length) throw new Error(`[formulaVersions] unknown source(s): ${unknown.join(", ")} (known: ${SOURCE_NAMES.join(", ")})`);
  await query(
    `INSERT INTO currency_formula_versions ("currency", "effectiveFrom", "formula", "by", "reason")
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT ("currency", "effectiveFrom") DO UPDATE SET
       "formula" = EXCLUDED."formula",
       "by"      = EXCLUDED."by",
       "reason"  = EXCLUDED."reason",
       "createdAt" = NOW()`,
    [currency, effectiveFrom, JSON.stringify({ sources }), by, reason ?? null],
  );
  log(`[formulaVersions] ${currency} version effectiveFrom=${effectiveFrom.toISOString()} sources=[${sources.join(",")}] by=${by}${reason ? ` (${reason})` : ""}`);
}

/** Delete a single timeline version (operator editing the timeline). */
export async function deleteFormulaVersion(currency: string, effectiveFrom: Date): Promise<boolean> {
  const res = await query(
    `DELETE FROM currency_formula_versions WHERE "currency" = $1 AND "effectiveFrom" = $2`,
    [currency, effectiveFrom],
  );
  const n = res.rowCount ?? 0;
  if (n > 0) log(`[formulaVersions] ${currency} deleted version effectiveFrom=${effectiveFrom.toISOString()}`);
  return n > 0;
}

/**
 * Resolve the inclusive source set as-of `minute` from a PRE-LOADED ascending
 * timeline (greatest effectiveFrom <= minute). Returns null when no version
 * applies (timeline empty, or minute precedes the earliest breakpoint — the
 * latter is an anomaly post-seed and the caller must fail loud, never fall back
 * to getCurrentFormula for a historical minute).
 */
export function resolveFormulaAt(timeline: FormulaVersion[], minute: Date): string[] | null {
  const m = minute.getTime();
  let chosen: FormulaVersion | null = null;
  for (const v of timeline) {
    if (v.effectiveFrom.getTime() <= m) chosen = v;
    else break; // ascending — nothing later can apply
  }
  return chosen ? chosen.sources : null;
}

/**
 * Union of every source any minute in [from, to) could compose with — the FETCH
 * set for a heal/repair that spans one or more breakpoints. The version active at
 * `from` plus every version starting inside the window.
 */
export function resolveFormulaUnion(timeline: FormulaVersion[], from: Date, to: Date): string[] {
  const union = new Set<string>();
  const atFrom = resolveFormulaAt(timeline, from);
  if (atFrom) atFrom.forEach((s) => union.add(s));
  for (const v of timeline) {
    if (v.effectiveFrom.getTime() >= from.getTime() && v.effectiveFrom.getTime() < to.getTime()) {
      v.sources.forEach((s) => union.add(s));
    }
  }
  return [...union];
}

/**
 * The repair/heal FETCH set for [from, to): the union of every venue any minute
 * in the window could compose with, resolved from the (lazily-seeded) timeline.
 * This is the per-currency intent — NOT getActiveFeeds (the live set) and NOT
 * minus the auto-ban overlay. Empty when the timeline can't be seeded yet.
 */
export async function resolveRepairSources(currency: string, from: Date, to: Date): Promise<string[]> {
  const timeline = await ensureSeededTimeline(currency);
  if (timeline.length === 0) return [];
  return resolveFormulaUnion(timeline, from, to);
}

/** The current LIVE effective set: available ∩ enabled feeds minus the global kill-switch. */
async function liveEffectiveSources(currency: string): Promise<string[]> {
  const excluded = new Set(getCurrentFormula().excludedSources);
  const feeds = await getActiveFeeds(currency);
  return feeds.map((f) => f.source).filter((s) => !excluded.has(s));
}

/**
 * Return the currency's timeline, lazily seeding a baseline version if it has
 * none. The seed is the current LIVE effective formula effective from the epoch,
 * so all history resolves to it until the operator adds a breakpoint.
 *
 * If the live effective set is empty (e.g. a fresh DB where currency_sources are
 * not yet probed available) we do NOT seed — an empty epoch row would freeze a
 * wrong baseline. Returns []; the caller no-ops exactly like "no active feeds".
 */
export async function ensureSeededTimeline(currency: string): Promise<FormulaVersion[]> {
  let timeline = await getFormulaTimeline(currency);
  if (timeline.length > 0) return timeline;

  const seedSources = await liveEffectiveSources(currency);
  if (seedSources.length === 0) {
    logWarn(`[formulaVersions] ${currency} timeline empty and no LIVE effective feeds (available ∩ enabled minus excludes) — not seeding yet (set currency_sources.available first)`);
    return [];
  }
  await insertFormulaVersion(currency, SEED_EFFECTIVE_FROM, seedSources, "auto-seed", "initial seed from current LIVE effective formula");
  logWarn(`[formulaVersions] ${currency} timeline was empty — seeded epoch baseline sources=[${seedSources.join(",")}]`);
  timeline = await getFormulaTimeline(currency);
  return timeline;
}
