/**
 * Per-venue local USDT/USD rate archive. See plan:
 * candleserv-stablecoin-aware-index §Phase 1.
 *
 * This table is currency-agnostic (peg is per-venue, asset-independent). The FK
 * to candles_1m_sources(timestamp, source) was dropped under multi-currency
 * D-STABLE-FK — once that PK gained "currency", (timestamp, source) was no
 * longer a unique target. The soft invariant (a rate row implies ≥1 currency
 * was fetched from that venue that minute) is held by collector ordering, not a
 * constraint. The collector writes both halves of every venue bundle in a
 * single transaction via withTransaction — the SQL below is the canonical
 * shape, but the live write path inlines it inside the transaction (see
 * collector.ts) so it shares a connection with the candle insert.
 */
import type { PoolClient, QueryResult } from "pg";
import { query } from "./pool.js";

export interface StableRateRow {
  timestamp: Date;
  source: string;       // BTC adapter name: 'binance' | 'bybit' | 'bitget' | 'gate'
  rate: number;         // local USDT→USD (e.g. 0.99929)
  pegSourcePair: string; // provenance: 'USDCUSDT' | 'USDTUSD' | 'USDC_USDT'
}

/**
 * Upsert a stable rate row. Pool path (no transaction) — used by the backfill.
 * The live collector inlines the same SQL inside its withTransaction block so
 * the rate row commits atomically with its paired BTC row.
 */
export async function upsertStableRate(r: StableRateRow): Promise<void> {
  await query(
    `INSERT INTO stable_rates_1m_sources
       ("timestamp","source","rate","pegSourcePair")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ("timestamp","source") DO UPDATE SET
       rate = EXCLUDED.rate,
       "pegSourcePair" = EXCLUDED."pegSourcePair",
       "updatedAt" = NOW()`,
    [r.timestamp, r.source, r.rate, r.pegSourcePair],
  );
}

/**
 * Same SQL, but executed inside a caller-supplied transaction.
 */
export async function upsertStableRateTx(client: PoolClient, r: StableRateRow): Promise<QueryResult> {
  return client.query(
    `INSERT INTO stable_rates_1m_sources
       ("timestamp","source","rate","pegSourcePair")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT ("timestamp","source") DO UPDATE SET
       rate = EXCLUDED.rate,
       "pegSourcePair" = EXCLUDED."pegSourcePair",
       "updatedAt" = NOW()`,
    [r.timestamp, r.source, r.rate, r.pegSourcePair],
  );
}

/**
 * Return all venue rates at the given minute, keyed by BTC source name.
 * USD-native venues are absent from the map (caller treats absent as identity).
 */
export async function getStableRatesAt(ts: Date): Promise<Map<string, number>> {
  const res = await query(
    `SELECT source, rate FROM stable_rates_1m_sources WHERE "timestamp" = $1`,
    [ts],
  );
  const out = new Map<string, number>();
  for (const row of res.rows as { source: string; rate: string }[]) {
    out.set(row.source, Number(row.rate));
  }
  return out;
}

/**
 * Drop stale peg rows. The peg table is SHARED (no currency column — one row per
 * minute+venue), so it SNAPS TO THE OLDEST retention across currencies: a peg at
 * minute X is needed by ANY currency holding a candle at X, so it must survive as
 * long as the most-retained currency (Stage 7, decision D5). Floored at the
 * global 180 default via GREATEST.
 *
 * This is the SOLE prune path: the FK to candles_1m_sources (and its ON DELETE
 * CASCADE) was dropped under multi-currency D-STABLE-FK, so nothing removes stale
 * rate rows implicitly — this must run in the daily maintenance loop or rates
 * accumulate unbounded.
 */
export async function pruneOldStableRates(): Promise<void> {
  await query(
    `DELETE FROM stable_rates_1m_sources
      WHERE "timestamp" < NOW() - make_interval(days =>
        GREATEST((SELECT MAX(COALESCE("sourceRetentionDays", 180)) FROM currencies), 180))`,
  );
}
