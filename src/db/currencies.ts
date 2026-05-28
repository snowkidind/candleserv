import { query } from "./pool.js";

export interface CurrencyRow {
  code: string;
  displayName: string;
  enabled: boolean;
  premiumEnabled: boolean;
  flatFillEmpty: boolean;
  minSources: number | null;
  inceptionTs: Date | null;
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
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listCurrencies(): Promise<CurrencyRow[]> {
  const res = await query(`SELECT * FROM currencies ORDER BY "code" ASC`);
  return res.rows.map(rowToCurrency);
}

export async function getEnabledCurrencies(): Promise<string[]> {
  const res = await query(`SELECT "code" FROM currencies WHERE enabled = true ORDER BY "code" ASC`);
  return res.rows.map((r: { code: string }) => r.code);
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
