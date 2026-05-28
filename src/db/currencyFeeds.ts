import { query } from "./pool.js";

export interface FeedRow {
  currency: string;
  source: string;
  symbol: string;
  available: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveFeed {
  source: string;
  symbol: string;
}

function rowToFeed(row: Record<string, unknown>): FeedRow {
  return {
    currency: row.currency as string,
    source: row.source as string,
    symbol: row.symbol as string,
    available: row.available as boolean,
    enabled: row.enabled as boolean,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

// Full per-source feed state for one currency — used by the Feeds tab.
export async function getFeedMap(
  currency: string
): Promise<Record<string, { symbol: string; available: boolean; enabled: boolean }>> {
  const res = await query(
    `SELECT * FROM currency_sources WHERE "currency" = $1 ORDER BY "source" ASC`,
    [currency]
  );
  const map: Record<string, { symbol: string; available: boolean; enabled: boolean }> = {};
  for (const row of res.rows.map(rowToFeed)) {
    map[row.source] = { symbol: row.symbol, available: row.available, enabled: row.enabled };
  }
  return map;
}

// The effective fetch set for a currency: probed-available AND operator-enabled.
// Consumers (collector, healer, repair) still subtract formula_changes
// excludedSources on top of this — that global venue kill-switch is applied by
// the caller, not here.
export async function getActiveFeeds(currency: string): Promise<ActiveFeed[]> {
  const res = await query(
    `SELECT "source", "symbol" FROM currency_sources
     WHERE "currency" = $1 AND "available" = true AND "enabled" = true
     ORDER BY "source" ASC`,
    [currency]
  );
  return res.rows.map((r: { source: string; symbol: string }) => ({ source: r.source, symbol: r.symbol }));
}

export async function setFeedEnabled(currency: string, source: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE currency_sources SET "enabled" = $3, "updatedAt" = NOW()
     WHERE "currency" = $1 AND "source" = $2`,
    [currency, source, enabled]
  );
}

export async function setAvailability(currency: string, source: string, available: boolean): Promise<void> {
  await query(
    `UPDATE currency_sources SET "available" = $3, "updatedAt" = NOW()
     WHERE "currency" = $1 AND "source" = $2`,
    [currency, source, available]
  );
}

export async function upsertSymbol(
  currency: string,
  source: string,
  symbol: string
): Promise<FeedRow> {
  const res = await query(
    `INSERT INTO currency_sources ("currency", "source", "symbol")
     VALUES ($1, $2, $3)
     ON CONFLICT ("currency", "source") DO UPDATE SET
       "symbol" = EXCLUDED."symbol", "updatedAt" = NOW()
     RETURNING *`,
    [currency, source, symbol]
  );
  return rowToFeed(res.rows[0]);
}
