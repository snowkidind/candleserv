/**
 * Per-venue local USDT/USD rate archive.
 *
 * This table is currency-agnostic (peg is per-venue, asset-independent). It has
 * no FK to candles_1m_sources — (timestamp, source) is not a unique target there
 * once the PK includes "currency". The soft invariant (a rate row implies ≥1
 * currency was fetched from that venue that minute) is held by collector
 * ordering, not a constraint. The collector writes both halves of every venue bundle in a
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
 * long as the most-retained currency. Floored at the
 * global 180 default via GREATEST.
 *
 * This is the SOLE prune path: stable_rates_1m_sources has no FK to
 * candles_1m_sources and no ON DELETE CASCADE, so nothing removes stale rate rows
 * implicitly — this must run in the daily maintenance loop or rates accumulate
 * unbounded.
 */
export async function pruneOldStableRates(): Promise<void> {
  await query(
    `DELETE FROM stable_rates_1m_sources
      WHERE "timestamp" < NOW() - make_interval(days =>
        GREATEST((SELECT MAX(COALESCE("sourceRetentionDays", 180)) FROM currencies), 180))`,
  );
}

// ---------------------------------------------------------------------------
// Read-only peg helpers — power the /v1/peg endpoints (routes/v1/peg.ts).
// stable_rates_1m_sources is a READ-ONLY source of truth here: no inserts,
// updates, or prunes. Every read filters `rejected = false` (rejected rows are
// bad data and must never surface). No try/catch — a `query` throw propagates
// to the route handler's catch (fail loud).
// ---------------------------------------------------------------------------

/**
 * The per-venue USDT→USD peg rates at the last closed minute (MAX(timestamp)
 * over non-rejected rows). One query returns both the timestamp and the rows —
 * a two-query MAX-then-select form both double-scans and races an insert
 * between the calls, desyncing `timestamp` from `rates`. Empty table → both the
 * subquery-MAX and the outer query yield no rows → { timestamp: null, rates: [] }.
 */
export async function getLatestPegRates(): Promise<{ timestamp: Date | null; rates: { source: string; rate: number }[] }> {
  const res = await query(
    `SELECT "timestamp", source, rate FROM stable_rates_1m_sources
      WHERE "timestamp" = (SELECT MAX("timestamp") FROM stable_rates_1m_sources WHERE rejected = false)
        AND rejected = false
      ORDER BY source ASC`,
  );
  const timestamp = res.rows.length ? (res.rows[0].timestamp as Date) : null;
  const rates = res.rows.map((r) => ({ source: r.source as string, rate: Number(r.rate) }));
  return { timestamp, rates };
}

// One OHLC-of-rate bar for one venue in one time bucket.
export interface PegBar { source: string; t: number; o: number; h: number; l: number; c: number; n: number }

/**
 * OHLC-of-rate buckets per venue over (from, to], aggregated from 1m rows —
 * mirrors getCandles' bucket-alignment aggregation, with `source` added to the
 * GROUP/ORDER and NO global LIMIT (a global LIMIT would starve later-sorted
 * venues; the route trims per-venue in JS). Optional `venue` filters to one
 * source. The WHERE fragment and params array are built together conditionally.
 */
export async function getPegBuckets(mins: number, from: Date, to: Date, venue?: string): Promise<PegBar[]> {
  const params: unknown[] = venue ? [mins, to, from, venue] : [mins, to, from];
  const venueClause = venue ? " AND source = $4" : "";
  const res = await query(
    `SELECT source,
            to_timestamp(FLOOR(EXTRACT(EPOCH FROM "timestamp") / ($1 * 60)) * ($1 * 60)) AS bucket,
            (array_agg(rate ORDER BY "timestamp" ASC))[1]  AS o,
            MAX(rate) AS h,
            MIN(rate) AS l,
            (array_agg(rate ORDER BY "timestamp" DESC))[1] AS c,
            COUNT(*) AS n
       FROM stable_rates_1m_sources
      WHERE "timestamp" <= $2 AND "timestamp" > $3 AND rejected = false${venueClause}
      GROUP BY source, bucket
      ORDER BY source ASC, bucket ASC`,
    params,
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    source: row.source as string,
    t: new Date(row.bucket as string | Date).getTime(),
    o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c),
    n: Number(row.n),
  }));
}

// Coverage window for one peg venue. Timestamps are unix ms (matching
// getSourcePresence / the `t` field on peg bars), not raw ISO.
export interface PegVenueMeta { source: string; oldest: number | null; newest: number | null; count: number }

/**
 * Per-venue coverage window over stable_rates_1m_sources (non-rejected rows).
 * Powers GET /v1/peg/venues.
 */
export async function getPegPresence(): Promise<PegVenueMeta[]> {
  const res = await query(
    `SELECT source, MIN("timestamp") AS oldest, MAX("timestamp") AS newest, COUNT(*) AS count
       FROM stable_rates_1m_sources
      WHERE rejected = false
      GROUP BY source`,
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    source: row.source as string,
    oldest: row.oldest ? new Date(row.oldest as string | Date).getTime() : null,
    newest: row.newest ? new Date(row.newest as string | Date).getTime() : null,
    count: Number(row.count),
  }));
}
