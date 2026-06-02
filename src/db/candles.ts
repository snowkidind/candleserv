import { query } from "./pool.js";
import type { CandleRow, CandleJson } from "../types/index.js";

// Public candle JSON surface. The `volume` field carries the NORMALIZED value
// (volume × baseline/sourceCount), not the raw cross-source sum. The internal
// DB schema still has both columns; this is just the API projection.
// See plan: candleserv-exchange-expansion §Phase 2.5 (volume API consolidation).
export function rowToJson(row: Record<string, unknown>): CandleJson {
  return {
    timestamp: new Date(row.timestamp as string | Date).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volumeNormalized),
    sourceCount: Number(row.sourceCount),
    sourceCountBaseline: Number(row.sourceCountBaseline),
    sources: Number(row.sources),
    confidence: Number(row.confidence),
  };
}

/**
 * Upsert a composite 1m candle.
 */
export async function upsertCandle(c: {
  currency: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volumeNormalized: number;
  sourceCount: number;
  sourceCountBaseline: number;
  sources: number;
  confidence: number;
}): Promise<void> {
  await query(
    `INSERT INTO candles_1m
       ("currency","timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT ("currency","timestamp") DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, "volumeNormalized" = EXCLUDED."volumeNormalized",
       "sourceCount" = EXCLUDED."sourceCount", "sourceCountBaseline" = EXCLUDED."sourceCountBaseline",
       sources = EXCLUDED.sources, confidence = EXCLUDED.confidence,
       "updatedAt" = NOW()`,
    [c.currency, c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.volumeNormalized,
     c.sourceCount, c.sourceCountBaseline, c.sources, c.confidence]
  );
}

/**
 * Insert a candle only if that timestamp doesn't already exist.
 * Used by backfill so it never overwrites live-collected multi-source data.
 */
export async function insertCandleIfMissing(c: Parameters<typeof upsertCandle>[0]): Promise<void> {
  await query(
    `INSERT INTO candles_1m
       ("currency","timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT ("currency","timestamp") DO NOTHING`,
    [c.currency, c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.volumeNormalized,
     c.sourceCount, c.sourceCountBaseline, c.sources, c.confidence]
  );
}

/**
 * Upsert a per-source raw candle row.
 *
 * usedInFormula is a byproduct of compose, not an input — callers in the
 * compose path pass the result of "did this row contribute to the composite
 * just written?" Live tick and healMinute both write composite + per-source
 * rows together, so the flag reflects that composite's verdict. NULL means
 * "no composite has been computed for this minute" (see schema invariant).
 */
export async function upsertSourceCandle(c: {
  currency: string;
  timestamp: Date;
  source: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rejected: boolean;
  rejectedReason?: string | null;
  usedInFormula?: boolean | null;
}): Promise<void> {
  await query(
    `INSERT INTO candles_1m_sources
       ("currency","timestamp","source","open","high","low","close","volume","rejected","rejectedReason","usedInFormula")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ("currency","timestamp","source") DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, rejected = EXCLUDED.rejected, "rejectedReason" = EXCLUDED."rejectedReason",
       "usedInFormula" = EXCLUDED."usedInFormula",
       "updatedAt" = NOW()`,
    [c.currency, c.timestamp, c.source, c.open, c.high, c.low, c.close, c.volume,
     c.rejected, c.rejectedReason ?? null, c.usedInFormula ?? null]
  );
}

/**
 * Get the mode of sourceCount over the trailing 1440 rows (24h baseline).
 */
export async function getSourceCountBaseline(currency: string): Promise<number> {
  const res = await query(`
    SELECT "sourceCount", COUNT(*) as cnt
    FROM (SELECT "sourceCount" FROM candles_1m WHERE "currency" = $1 ORDER BY "timestamp" DESC LIMIT 1440) sub
    GROUP BY "sourceCount"
    ORDER BY cnt DESC
    LIMIT 1
  `, [currency]);
  if (!res.rows.length) return 5; // cold-start default
  return Number(res.rows[0].sourceCount);
}

/**
 * Standard deviation of close prices over the trailing 1440 rows (24h).
 * Used as the outlier rejection threshold in the composite engine.
 */
export async function getRecentCloseStddev(currency: string): Promise<number> {
  const res = await query(`
    SELECT STDDEV(close) as sigma
    FROM (SELECT close FROM candles_1m WHERE "currency" = $1 ORDER BY "timestamp" DESC LIMIT 1440) sub
  `, [currency]);
  const sigma = Number(res.rows[0]?.sigma);
  return isNaN(sigma) || sigma < 10 ? 10 : sigma; // $10 floor for cold-start
}

/**
 * Fetch the latest N 1m candles, oldest first.
 */
export async function getLatest1m(currency: string, n: number): Promise<CandleJson[]> {
  const res = await query(
    `SELECT * FROM (SELECT * FROM candles_1m WHERE "currency" = $1 ORDER BY "timestamp" DESC LIMIT $2) sub
     ORDER BY "timestamp" ASC`,
    [currency, n]
  );
  return res.rows.map(rowToJson);
}

/**
 * Fetch N candles ending at (inclusive) for any timeframe.
 * Higher TFs are aggregated from 1m rows on the fly.
 */
export async function getCandles(opts: {
  currency: string;
  tf: string;
  endingAt: Date;
  limit: number;
}): Promise<CandleJson[]> {
  const { currency, tf, endingAt, limit } = opts;
  const minutes = tfToMinutes(tf);

  if (tf === "30d") {
    return getCalendarMonthlyCandles(currency, endingAt, limit);
  }

  if (minutes === 1) {
    const res = await query(
      `SELECT * FROM (
         SELECT * FROM candles_1m
         WHERE "currency" = $1 AND "timestamp" <= $2
         ORDER BY "timestamp" DESC LIMIT $3
       ) sub ORDER BY "timestamp" ASC`,
      [currency, endingAt, limit]
    );
    return res.rows.map(rowToJson);
  }

  // Aggregate from 1m: align to bucket boundaries, group, aggregate.
  // The `volume` output carries the NORMALIZED sum (volume × baseline/sourceCount
  // per minute, then summed across the bucket). This corrects a latent bug
  // where the function previously returned raw cross-source sums — fine while
  // sourceCount was constant historically, wrong once 5→8 expansion landed.
  const windowStart = new Date(endingAt.getTime() - minutes * limit * 60 * 1000);
  const res = await query(
    `SELECT
       to_timestamp(
         FLOOR(EXTRACT(EPOCH FROM "timestamp") / ($1 * 60)) * ($1 * 60)
       ) AS bucket,
       (array_agg(open ORDER BY "timestamp" ASC))[1] AS open,
       MAX(high) AS high,
       MIN(low) AS low,
       (array_agg(close ORDER BY "timestamp" DESC))[1] AS close,
       SUM("volumeNormalized") AS volume,
       MAX("sourceCount") AS "sourceCount",
       MAX("sourceCountBaseline") AS "sourceCountBaseline",
       bit_or(sources) AS sources,
       AVG(confidence) AS confidence
     FROM candles_1m
     WHERE "currency" = $5
       AND "timestamp" <= $2
       AND "timestamp" > $3
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $4`,
    [minutes, endingAt, windowStart, limit, currency]
  );

  return res.rows
    .map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.bucket as string).getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      sourceCount: Number(row.sourceCount),
      sourceCountBaseline: Number(row.sourceCountBaseline),
      sources: Number(row.sources),
      confidence: Number(row.confidence),
    }))
    .reverse();
}

async function getCalendarMonthlyCandles(currency: string, endingAt: Date, limit: number): Promise<CandleJson[]> {
  const res = await query(
    `SELECT
       date_trunc('month', "timestamp") AS bucket,
       (array_agg(open ORDER BY "timestamp" ASC))[1] AS open,
       MAX(high) AS high,
       MIN(low) AS low,
       (array_agg(close ORDER BY "timestamp" DESC))[1] AS close,
       SUM("volumeNormalized") AS volume,
       MAX("sourceCount") AS "sourceCount",
       MAX("sourceCountBaseline") AS "sourceCountBaseline",
       bit_or(sources) AS sources,
       AVG(confidence) AS confidence
     FROM candles_1m
     WHERE "currency" = $3
       AND "timestamp" <  date_trunc('month', $1::timestamptz) + INTERVAL '1 month'
       AND "timestamp" >= date_trunc('month', $1::timestamptz) - ($2 * INTERVAL '1 month')
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $2`,
    [endingAt, limit, currency]
  );
  return res.rows
    .map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.bucket as string).getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      sourceCount: Number(row.sourceCount),
      sourceCountBaseline: Number(row.sourceCountBaseline),
      sources: Number(row.sources),
      confidence: Number(row.confidence),
    }))
    .reverse();
}

export function tfToMinutes(tf: string): number {
  const map: Record<string, number> = {
    "1m": 1, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
    "1h": 60, "2h": 120, "4h": 240, "6h": 360, "12h": 720,
    "1d": 1440, "3d": 4320, "7d": 10080,
  };
  return map[tf] ?? 1;
}

export const VALID_TFS = ["1m","5m","10m","15m","30m","1h","2h","4h","6h","12h","1d","3d","7d","30d"];

/**
 * Count candles in a day window (for backfill check).
 */
export async function countCandlesInDay(currency: string, dayStart: Date): Promise<number> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const res = await query(
    `SELECT COUNT(*) FROM candles_1m WHERE "currency" = $1 AND "timestamp" >= $2 AND "timestamp" < $3`,
    [currency, dayStart, dayEnd]
  );
  return Number(res.rows[0].count);
}

/**
 * Get collection latency stats over the last N rows.
 */
export async function getCollectionLatencyStats(currency: string, sample = 60): Promise<{
  avgMs: number;
  minMs: number;
  maxMs: number;
  sampleSize: number;
}> {
  // "timestamp" is the candle's OPEN minute, so it covers [timestamp, timestamp+60s)
  // and cannot exist until it closes at timestamp+60s. Collection latency is the gap
  // from candle CLOSE to persistence — subtract the 1-minute candle duration, else
  // every reading carries a meaningless +60000ms baseline (the candle's own length).
  const res = await query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM ("createdAt" - "timestamp" - INTERVAL '1 minute')) * 1000) AS avg_ms,
       MIN(EXTRACT(EPOCH FROM ("createdAt" - "timestamp" - INTERVAL '1 minute')) * 1000) AS min_ms,
       MAX(EXTRACT(EPOCH FROM ("createdAt" - "timestamp" - INTERVAL '1 minute')) * 1000) AS max_ms,
       COUNT(*) AS cnt
     FROM (SELECT "timestamp", "createdAt" FROM candles_1m WHERE "currency" = $1 ORDER BY "timestamp" DESC LIMIT $2) sub`,
    [currency, sample]
  );
  const row = res.rows[0];
  return {
    avgMs: Math.round(Number(row.avg_ms) || 0),
    minMs: Math.round(Number(row.min_ms) || 0),
    maxMs: Math.round(Number(row.max_ms) || 0),
    sampleSize: Number(row.cnt),
  };
}

/**
 * Snapshot operational metrics for one source over the trailing 24h — the
 * statsAtExclusion payload for formula_changes rows. Sentinel rows (rejected
 * with rejectedReason='no_data') are excluded from rate denominators so they
 * don't dilute the metric. Returns nulls on any query error so the caller
 * can persist the exclusion regardless.
 *
 * Deliberately currency-agnostic: auto-suspend is a venue kill-switch that
 * excludes a source across every currency, so the health snapshot aggregates
 * the venue's rows over all currencies rather than filtering to one.
 */
export async function get24hSourceStats(source: string): Promise<{
  outlierRate24h: number | null;
  usedRate24h: number | null;
}> {
  try {
    const res = await query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE("rejectedReason", '') <> 'no_data')              AS total,
         COUNT(*) FILTER (WHERE "rejectedReason" = 'outlier')                              AS outlier,
         COUNT(*) FILTER (WHERE "usedInFormula" = true)                                    AS used
       FROM candles_1m_sources
      WHERE source = $1
        AND "timestamp" >= NOW() - INTERVAL '24 hours'`,
      [source],
    );
    const r = res.rows[0] as { total: string; outlier: string; used: string } | undefined;
    if (!r) return { outlierRate24h: null, usedRate24h: null };
    const total = Number(r.total);
    if (total === 0) return { outlierRate24h: null, usedRate24h: null };
    return {
      outlierRate24h: Number(r.outlier) / total,
      usedRate24h: Number(r.used) / total,
    };
  } catch {
    return { outlierRate24h: null, usedRate24h: null };
  }
}

/**
 * Prune candles_1m_sources older than 180 days. 180d is the SOURCE-archive
 * retention floor and the default repair horizon. The repair horizon is now
 * operator-configurable (repairHorizonDays app_setting; see lib/retention.ts):
 * a repair reaching beyond 180d re-fetches that window from the exchange and
 * recomposes candles_1m (kept forever), then those re-fetched source rows prune
 * here again on the next daily cycle. So source older than 180d is composite-
 * only between repairs by design — the archive does not grow unbounded.
 */
export async function pruneSourceCandles(): Promise<void> {
  await query(
    `DELETE FROM candles_1m_sources WHERE "timestamp" < NOW() - INTERVAL '180 days'`
  );
}

// Per-source 1m OHLCV over a window, with each venue's peg rate joined in (null
// for USD-native venues). Feeds the Candles-tab source-info hover popup, which is
// 1m-only and loaded once per session. Compact field names to keep the (large,
// load-once) payload small. `peg` is currency-agnostic (D-STABLE-FK).
export interface SourceCandleRow {
  t: number;          // unix seconds (bar open)
  source: string;
  o: number; h: number; l: number; c: number; v: number;
  rejected: boolean;
  peg: number | null; // USDT→USD rate for peg venues; null for USD-native
}

export async function getSourceCandles(currency: string, from: Date, to: Date): Promise<SourceCandleRow[]> {
  const res = await query(
    `SELECT EXTRACT(EPOCH FROM s."timestamp")::bigint AS t, s.source,
            s.open AS o, s.high AS h, s.low AS l, s.close AS c, s.volume AS v, s.rejected,
            r.rate AS peg
     FROM candles_1m_sources s
     LEFT JOIN stable_rates_1m_sources r
       ON r."timestamp" = s."timestamp" AND r.source = s.source
     WHERE s."currency" = $1 AND s."timestamp" >= $2 AND s."timestamp" < $3
     ORDER BY s."timestamp" ASC, s.source ASC`,
    [currency, from, to],
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    t: Number(row.t),
    source: row.source as string,
    o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), v: Number(row.v),
    rejected: row.rejected as boolean,
    peg: row.peg == null ? null : Number(row.peg),
  }));
}

/**
 * Per-source presence + coverage window over candles_1m_sources for one
 * currency. Powers GET /v1/premium/venues (which venues have derivable premium
 * history and how far back). `oldest`/`newest` are unix-ms bar-open timestamps;
 * null when the venue has never produced a row for the currency.
 */
export async function getSourcePresence(currency: string): Promise<
  { source: string; oldest: number | null; newest: number | null; count: number }[]
> {
  const res = await query(
    `SELECT source,
            MIN("timestamp") AS oldest,
            MAX("timestamp") AS newest,
            COUNT(*)          AS count
       FROM candles_1m_sources
      WHERE "currency" = $1
      GROUP BY source
      ORDER BY source ASC`,
    [currency],
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    source: row.source as string,
    oldest: row.oldest == null ? null : new Date(row.oldest as string | Date).getTime(),
    newest: row.newest == null ? null : new Date(row.newest as string | Date).getTime(),
    count: Number(row.count),
  }));
}

/**
 * Returns the source with the highest total volume across the last N accepted
 * 1m source-candle rows. Used by the collector to select the dominant H/L source.
 * Returns null if candles_1m_sources is empty (cold start).
 */
export async function getTrailingVolumeLeader(currency: string, n = 10): Promise<string | null> {
  const res = await query(
    `SELECT source, SUM(volume) AS total_vol
     FROM candles_1m_sources
     WHERE "currency" = $1 AND rejected = false
       AND "timestamp" IN (
         SELECT DISTINCT "timestamp"
         FROM candles_1m_sources
         WHERE "currency" = $1 AND rejected = false
         ORDER BY "timestamp" DESC
         LIMIT $2
       )
     GROUP BY source
     ORDER BY total_vol DESC
     LIMIT 1`,
    [currency, n]
  );
  return (res.rows[0]?.source as string) ?? null;
}

/**
 * Most recent real (non-rejected) close for a (currency, source). Used by the
 * collector's flat-fill path (D-FLATFILL) to seed the in-memory lastClose map
 * on cold start. Returns null if the venue has never produced a candle for the
 * currency (brand-new listing → caller omits the venue, no flat-fill).
 */
export async function getLastSourceClose(currency: string, source: string): Promise<number | null> {
  const res = await query(
    `SELECT close FROM candles_1m_sources
      WHERE "currency" = $1 AND source = $2 AND rejected = false
      ORDER BY "timestamp" DESC LIMIT 1`,
    [currency, source]
  );
  return res.rows.length ? Number(res.rows[0].close) : null;
}
