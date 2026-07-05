import { query } from "./pool.js";
import { log } from "../lib/log.js";

// TON → GRAM rebrand transitional read alias (decision D1). The old `TON`
// request code resolves to the renamed `GRAM` data on the /v1 read path only —
// an explicit declared map, never a silent "try the other name". Deleted in
// Stage 6 once no consumer requests TON. Do NOT alias the /monitor admin
// surface or any write path.
const CURRENCY_ALIASES: Record<string, string> = { TON: "GRAM" };

/**
 * Canonicalize a raw ?currency value to a currency code. Returns "BTC" for
 * empty/blank input (preserves the pre-multi-currency default), otherwise
 * uppercases and maps through CURRENCY_ALIASES (logging when an alias fires).
 * Returns a code only — validation against getEnabledCurrencies stays in the
 * callers, so an unknown/non-aliased code still 400s there.
 */
export function canonicalCurrency(raw: unknown): string {
  const upper = (typeof raw === "string" && raw.trim()) ? raw.trim().toUpperCase() : "BTC";
  const alias = CURRENCY_ALIASES[upper];
  if (alias) {
    log(`[currency] alias ${upper}→${alias}`);
    return alias;
  }
  return upper;
}

export interface CurrencyRow {
  code: string;
  displayName: string;
  enabled: boolean;
  premiumEnabled: boolean;
  flatFillEmpty: boolean;
  minSources: number | null;
  inceptionTs: Date | null;
  sourceRetentionDays: number | null;   // null → global default 180 (Stage 7)
  createdAt: Date;
  updatedAt: Date;
}

function rowToCurrency(row: Record<string, unknown>): CurrencyRow {
  return {
    code: row.code as string,
    displayName: row.displayName as string,
    enabled: row.enabled as boolean,
    premiumEnabled: row.premiumEnabled as boolean,
    flatFillEmpty: row.flatFillEmpty as boolean,
    minSources: (row.minSources as number) ?? null,
    inceptionTs: (row.inceptionTs as Date) ?? null,
    sourceRetentionDays: (row.sourceRetentionDays as number) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listCurrencies(): Promise<CurrencyRow[]> {
  const res = await query(`SELECT * FROM currencies ORDER BY "code" ASC`);
  return res.rows.map(rowToCurrency);
}

// BTC is first-class (Required): it sorts ahead of every other code so the
// serialized backfill, gap scans, heal loops, and the live collector all process
// BTC before any alt. The rest stay alphabetical for stable ordering.
export async function getEnabledCurrencies(): Promise<string[]> {
  const res = await query(
    `SELECT "code" FROM currencies WHERE enabled = true ORDER BY ("code" = 'BTC') DESC, "code" ASC`,
  );
  return res.rows.map((r: { code: string }) => r.code);
}

// Same enabled filter + BTC-first ordering as getEnabledCurrencies, but carries
// each currency's inceptionTs temporal floor. Read by the GET /v1/currencies
// route so a downstream consumer (phaseserv) discovers the served set and its
// per-currency backfill floor over the API-key /v1 surface in one call. Does not
// replace getEnabledCurrencies (still used by resolveCurrency validation).
export async function getEnabledCurrencyInfo(): Promise<{ code: string; inceptionTs: Date | null }[]> {
  const res = await query(
    `SELECT "code", "inceptionTs" FROM currencies WHERE enabled = true ORDER BY ("code" = 'BTC') DESC, "code" ASC`,
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    code: row.code as string,
    inceptionTs: (row.inceptionTs as Date) ?? null,
  }));
}

export async function getCurrency(code: string): Promise<CurrencyRow | null> {
  const res = await query(`SELECT * FROM currencies WHERE "code" = $1`, [code]);
  return res.rows.length ? rowToCurrency(res.rows[0]) : null;
}

export async function setCurrencyEnabled(code: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE currencies SET enabled = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, enabled]
  );
}

export async function setPremiumEnabled(code: string, premiumEnabled: boolean): Promise<void> {
  await query(
    `UPDATE currencies SET "premiumEnabled" = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, premiumEnabled]
  );
}

// D-FLATFILL: when true, an empty (no-trade) minute for this currency flat-fills
// from the venue's previous close instead of counting as a fetch failure. Leave
// false for liquid assets (BTC/ETH/SOL) where an empty minute means a glitch.
export async function setFlatFillEmpty(code: string, flatFillEmpty: boolean): Promise<void> {
  await query(
    `UPDATE currencies SET "flatFillEmpty" = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, flatFillEmpty]
  );
}

export async function setMinSources(code: string, minSources: number | null): Promise<void> {
  await query(
    `UPDATE currencies SET "minSources" = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, minSources]
  );
}

// B3 temporal floor. Read by the gap scan + backfill window; callers MUST
// COALESCE a null result to (now - 90d), never treat null as epoch.
export async function getInceptionTs(code: string): Promise<Date | null> {
  const res = await query(`SELECT "inceptionTs" FROM currencies WHERE "code" = $1`, [code]);
  return res.rows.length ? ((res.rows[0].inceptionTs as Date) ?? null) : null;
}

export async function setInceptionTs(code: string, inceptionTs: Date | null): Promise<void> {
  await query(
    `UPDATE currencies SET "inceptionTs" = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, inceptionTs]
  );
}

// Stage 7: per-currency source-archive retention (days). null → global default
// (180; see retention.ts). The composite candles_1m is kept forever regardless;
// this governs only the per-venue source archive (candles_1m_sources) and, via
// the snap-to-oldest rule, the shared peg table.
export async function setSourceRetentionDays(code: string, days: number | null): Promise<void> {
  await query(
    `UPDATE currencies SET "sourceRetentionDays" = $2, "updatedAt" = NOW() WHERE "code" = $1`,
    [code, days]
  );
}

export interface UpsertCurrencyInput {
  code: string;
  displayName: string;
  enabled?: boolean;
  premiumEnabled?: boolean;
  flatFillEmpty?: boolean;
  minSources?: number | null;
  inceptionTs?: Date | null;
}

export async function upsertCurrency(input: UpsertCurrencyInput): Promise<CurrencyRow> {
  const res = await query(
    `INSERT INTO currencies ("code", "displayName", "enabled", "premiumEnabled", "flatFillEmpty", "minSources", "inceptionTs")
     VALUES ($1, $2, COALESCE($3, false), COALESCE($4, true), COALESCE($7, false), $5, $6)
     ON CONFLICT ("code") DO UPDATE SET
       "displayName"    = EXCLUDED."displayName",
       "enabled"        = COALESCE($3, currencies.enabled),
       "premiumEnabled" = COALESCE($4, currencies."premiumEnabled"),
       "flatFillEmpty"  = COALESCE($7, currencies."flatFillEmpty"),
       "minSources"     = EXCLUDED."minSources",
       "inceptionTs"    = EXCLUDED."inceptionTs",
       "updatedAt"      = NOW()
     RETURNING *`,
    [
      input.code,
      input.displayName,
      input.enabled ?? null,
      input.premiumEnabled ?? null,
      input.minSources ?? null,
      input.inceptionTs ?? null,
      input.flatFillEmpty ?? null,
    ]
  );
  return rowToCurrency(res.rows[0]);
}
