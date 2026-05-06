import { query } from "./pool.js";
import type { CandleRow, CandleJson } from "../types/index.js";

export function rowToJson(row: Record<string, unknown>): CandleJson {
  return {
    timestamp: new Date(row.timestamp as string | Date).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    volumeNormalized: Number(row.volumeNormalized),
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
       ("timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
     ON CONFLICT ("timestamp") DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, "volumeNormalized" = EXCLUDED."volumeNormalized",
       "sourceCount" = EXCLUDED."sourceCount", "sourceCountBaseline" = EXCLUDED."sourceCountBaseline",
       sources = EXCLUDED.sources, confidence = EXCLUDED.confidence,
       "updatedAt" = NOW()`,
    [c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.volumeNormalized,
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
       ("timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
     ON CONFLICT ("timestamp") DO NOTHING`,
    [c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.volumeNormalized,
     c.sourceCount, c.sourceCountBaseline, c.sources, c.confidence]
  );
}

/**
 * Upsert a per-source raw candle row.
 */
export async function upsertSourceCandle(c: {
  timestamp: Date;
  source: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rejected: boolean;
  rejectedReason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO candles_1m_sources
       ("timestamp","source","open","high","low","close","volume","rejected","rejectedReason")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT ("timestamp","source") DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, rejected = EXCLUDED.rejected, "rejectedReason" = EXCLUDED."rejectedReason"`,
    [c.timestamp, c.source, c.open, c.high, c.low, c.close, c.volume,
     c.rejected, c.rejectedReason ?? null]
  );
}

/**
 * Get the mode of sourceCount over the trailing 1440 rows (24h baseline).
 */
export async function getSourceCountBaseline(): Promise<number> {
  const res = await query(`
    SELECT "sourceCount", COUNT(*) as cnt
    FROM (SELECT "sourceCount" FROM candles_1m ORDER BY "timestamp" DESC LIMIT 1440) sub
    GROUP BY "sourceCount"
    ORDER BY cnt DESC
    LIMIT 1
  `);
  if (!res.rows.length) return 5; // cold-start default
  return Number(res.rows[0].sourceCount);
}

/**
 * Standard deviation of close prices over the trailing 1440 rows (24h).
 * Used as the outlier rejection threshold in the composite engine.
 */
export async function getRecentCloseStddev(): Promise<number> {
  const res = await query(`
    SELECT STDDEV(close) as sigma
    FROM (SELECT close FROM candles_1m ORDER BY "timestamp" DESC LIMIT 1440) sub
  `);
  const sigma = Number(res.rows[0]?.sigma);
  return isNaN(sigma) || sigma < 10 ? 10 : sigma; // $10 floor for cold-start
}

/**
 * Fetch the latest N 1m candles, oldest first.
 */
export async function getLatest1m(n: number): Promise<CandleJson[]> {
  const res = await query(
    `SELECT * FROM (SELECT * FROM candles_1m ORDER BY "timestamp" DESC LIMIT $1) sub
     ORDER BY "timestamp" ASC`,
    [n]
  );
  return res.rows.map(rowToJson);
}

/**
 * Fetch N candles ending at (inclusive) for any timeframe.
 * Higher TFs are aggregated from 1m rows on the fly.
 */
export async function getCandles(opts: {
  tf: string;
  endingAt: Date;
  limit: number;
}): Promise<CandleJson[]> {
  const { tf, endingAt, limit } = opts;
  const minutes = tfToMinutes(tf);

  if (tf === "30d") {
    return getCalendarMonthlyCandles(endingAt, limit);
  }

  if (minutes === 1) {
    const res = await query(
      `SELECT * FROM (
         SELECT * FROM candles_1m
         WHERE "timestamp" <= $1
         ORDER BY "timestamp" DESC LIMIT $2
       ) sub ORDER BY "timestamp" ASC`,
      [endingAt, limit]
    );
    return res.rows.map(rowToJson);
  }

  // Aggregate from 1m: align to bucket boundaries, group, aggregate
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
       SUM(volume) AS volume,
       SUM("volumeNormalized") AS "volumeNormalized",
       MAX("sourceCount") AS "sourceCount",
       MAX("sourceCountBaseline") AS "sourceCountBaseline",
       bit_or(sources) AS sources,
       AVG(confidence) AS confidence
     FROM candles_1m
     WHERE "timestamp" <= $2
       AND "timestamp" > $3
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $4`,
    [minutes, endingAt, windowStart, limit]
  );

  return res.rows
    .map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.bucket as string).getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      volumeNormalized: Number(row.volumeNormalized),
      sourceCount: Number(row.sourceCount),
      sourceCountBaseline: Number(row.sourceCountBaseline),
      sources: Number(row.sources),
      confidence: Number(row.confidence),
    }))
    .reverse();
}

async function getCalendarMonthlyCandles(endingAt: Date, limit: number): Promise<CandleJson[]> {
  const res = await query(
    `SELECT
       date_trunc('month', "timestamp") AS bucket,
       (array_agg(open ORDER BY "timestamp" ASC))[1] AS open,
       MAX(high) AS high,
       MIN(low) AS low,
       (array_agg(close ORDER BY "timestamp" DESC))[1] AS close,
       SUM(volume) AS volume,
       SUM("volumeNormalized") AS "volumeNormalized",
       MAX("sourceCount") AS "sourceCount",
       MAX("sourceCountBaseline") AS "sourceCountBaseline",
       bit_or(sources) AS sources,
       AVG(confidence) AS confidence
     FROM candles_1m
     WHERE "timestamp" <  date_trunc('month', $1::timestamptz) + INTERVAL '1 month'
       AND "timestamp" >= date_trunc('month', $1::timestamptz) - ($2 * INTERVAL '1 month')
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $2`,
    [endingAt, limit]
  );
  return res.rows
    .map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.bucket as string).getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      volumeNormalized: Number(row.volumeNormalized),
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
export async function countCandlesInDay(dayStart: Date): Promise<number> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const res = await query(
    `SELECT COUNT(*) FROM candles_1m WHERE "timestamp" >= $1 AND "timestamp" < $2`,
    [dayStart, dayEnd]
  );
  return Number(res.rows[0].count);
}

/**
 * Get collection latency stats over the last N rows.
 */
export async function getCollectionLatencyStats(sample = 60): Promise<{
  avgMs: number;
  minMs: number;
  maxMs: number;
  sampleSize: number;
}> {
  const res = await query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM ("createdAt" - "timestamp")) * 1000) AS avg_ms,
       MIN(EXTRACT(EPOCH FROM ("createdAt" - "timestamp")) * 1000) AS min_ms,
       MAX(EXTRACT(EPOCH FROM ("createdAt" - "timestamp")) * 1000) AS max_ms,
       COUNT(*) AS cnt
     FROM (SELECT "timestamp", "createdAt" FROM candles_1m ORDER BY "timestamp" DESC LIMIT $1) sub`,
    [sample]
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
 * Prune candles_1m_sources older than 30 days.
 */
export async function pruneSourceCandles(): Promise<void> {
  await query(
    `DELETE FROM candles_1m_sources WHERE "timestamp" < NOW() - INTERVAL '30 days'`
  );
}

/**
 * Returns the source with the highest total volume across the last N accepted
 * 1m source-candle rows. Used by the collector to select the dominant H/L source.
 * Returns null if candles_1m_sources is empty (cold start).
 */
export async function getTrailingVolumeLeader(n = 10): Promise<string | null> {
  const res = await query(
    `SELECT source, SUM(volume) AS total_vol
     FROM candles_1m_sources
     WHERE rejected = false
       AND "timestamp" IN (
         SELECT DISTINCT "timestamp"
         FROM candles_1m_sources
         WHERE rejected = false
         ORDER BY "timestamp" DESC
         LIMIT $1
       )
     GROUP BY source
     ORDER BY total_vol DESC
     LIMIT 1`,
    [n]
  );
  return (res.rows[0]?.source as string) ?? null;
}
