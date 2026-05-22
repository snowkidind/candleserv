/**
 * Per-venue local USDT/USD rate archive. See plan:
 * candleserv-stablecoin-aware-index §Phase 1.
 *
 * Rows here are FK-bound to candles_1m_sources(timestamp, source). The
 * collector writes both halves of every venue bundle in a single transaction
 * via withTransaction — the SQL below is the canonical shape, but the live
 * write path inlines it inside the transaction (see collector.ts) so it
 * shares a connection with the BTC insert.
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
 * Drop rows older than 180 days. Matches pruneSourceCandles retention.
 * ON DELETE CASCADE on candles_1m_sources also fires this implicitly when
 * the BTC archive prunes — this call is the symmetric direct path, harmless
 * to run because the cascade would already have removed the orphans.
 */
export async function pruneOldStableRates(): Promise<void> {
  await query(
    `DELETE FROM stable_rates_1m_sources WHERE "timestamp" < NOW() - INTERVAL '180 days'`,
  );
}
