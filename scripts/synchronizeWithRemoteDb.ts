/**
 * One-shot sync: pull rows from a remote candleserv Postgres into the local one.
 *
 * Inserts are idempotent — ON CONFLICT (primary key) DO NOTHING — so running
 * this against a partially-populated local DB only fills in the rows that are
 * missing and never overwrites existing local data. Safe to re-run.
 *
 * Both databases are the multi-currency (composite-PK) schema. The remote's
 * `currency` is carried through verbatim — every currency present on the remote
 * is synced, tagged with its own code.
 *
 * Tables synced:
 *   - candles_1m              (PK: currency, timestamp)
 *   - candles_1m_sources      (PK: currency, timestamp, source)   [unless --no-sources]
 *   - stable_rates_1m_sources (PK: timestamp, source)             [unless --no-sources]
 *       The per-venue peg rate is currency-agnostic (one row per minute+venue,
 *       shared across currencies), so it pairs with the source archive — without
 *       it a synced USDT-venue source row can't be recomposed.
 *
 * The LOCAL database is whatever candleserv itself uses (DATABASE_URL from
 * candleserv/.env, via src/db/pool.ts). The script only needs you to tell it
 * where the REMOTE source is:
 *
 *   REMOTE_DATABASE_URL   Postgres URL of the remote (read source) DB.
 *                         Read-only credentials are sufficient.
 *
 * No hardcoded host default — open-source repo, do not ship LAN topology in
 * committed code. The script refuses to run if REMOTE is unset or equals the
 * local DATABASE_URL.
 *
 * Usage:
 *   npx tsx scripts/synchronizeWithRemoteDb.ts
 *   npx tsx scripts/synchronizeWithRemoteDb.ts --from 2025-01-01
 *   npx tsx scripts/synchronizeWithRemoteDb.ts --from 2025-01-01 --to 2025-02-01
 *   npx tsx scripts/synchronizeWithRemoteDb.ts --no-sources
 *   npx tsx scripts/synchronizeWithRemoteDb.ts --dry-run
 *   npx tsx scripts/synchronizeWithRemoteDb.ts --batch-size 2000
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed (DB-side SET TIME ZONE 'UTC' is set on each remote connection below)
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

import { query as localQuery, getPool as getLocalPool } from "../src/db/pool";

const { Pool } = pg;

interface Args {
  from: string | null;
  to: string | null;
  batchSize: number;
  skipSources: boolean;
  dryRun: boolean;
}

function printUsage(): void {
  console.log(`
synchronizeWithRemoteDb — pull candleserv rows from a remote instance into the
local DB. Idempotent (ON CONFLICT DO NOTHING). Both DBs are the multi-currency
schema; every currency on the remote is synced under its own code.

Local DB:  uses DATABASE_URL from candleserv/.env (the project's own config).
Remote DB: must be supplied via env var.

Required env:
  REMOTE_DATABASE_URL   Postgres URL of the remote (source) candleserv DB.
                        Format:
                          postgres://<user>:<password>@<host>:<port>/<database>
                        Example:
                          postgres://candleserv_ro:passwd@192.168.1.xxx:5432/candleserv
                        Notes:
                          - port defaults to 5432 and may be omitted
                          - URL-encode special chars in the password (@ -> %40 etc.)
                          - append ?sslmode=require if the remote demands TLS
                          - read-only credentials are sufficient

Options:
  --from <ISO>          Lower bound (inclusive) on timestamp.
  --to   <ISO>          Upper bound (exclusive) on timestamp.
  --batch-size N        Rows per batch (default 4000).
  --no-sources          Skip candles_1m_sources and stable_rates_1m_sources.
  --dry-run             Report counts; do not write.
  -h, --help            Show this help.
`);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { from: null, to: null, batchSize: 4000, skipSources: false, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--from":        out.from = argv[++i] ?? null; break;
      case "--to":          out.to = argv[++i] ?? null; break;
      case "--batch-size":  out.batchSize = Number(argv[++i]); break;
      case "--no-sources":  out.skipSources = true; break;
      case "--dry-run":     out.dryRun = true; break;
      case "-h":
      case "--help":        printUsage(); process.exit(0);
      default:              throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!Number.isFinite(out.batchSize) || out.batchSize <= 0) {
    throw new Error(`--batch-size must be a positive integer, got: ${out.batchSize}`);
  }
  if (out.from && Number.isNaN(Date.parse(out.from))) {
    throw new Error(`--from is not a valid timestamp: ${out.from}`);
  }
  if (out.to && Number.isNaN(Date.parse(out.to))) {
    throw new Error(`--to is not a valid timestamp: ${out.to}`);
  }
  return out;
}

const URL_SCHEME_RE = /^postgres(ql)?:\/\//;

function assertScheme(name: string, value: string): void {
  if (!URL_SCHEME_RE.test(value)) {
    console.error(`FATAL: ${name} must start with 'postgres://' or 'postgresql://'.`);
    console.error(`       Got: ${value}`);
    console.error(`       Run with --help for the expected URL format.`);
    process.exit(1);
  }
}

function resolveRemoteUrl(): string {
  const local  = process.env.DATABASE_URL;
  const remote = process.env.REMOTE_DATABASE_URL;
  if (!local) {
    console.error("FATAL: DATABASE_URL is not set — candleserv cannot reach its own database.");
    printUsage();
    process.exit(1);
  }
  if (!remote) {
    console.error("FATAL: REMOTE_DATABASE_URL is not set.");
    printUsage();
    process.exit(1);
  }
  assertScheme("DATABASE_URL", local);
  assertScheme("REMOTE_DATABASE_URL", remote);
  if (local === remote) {
    console.error("FATAL: REMOTE_DATABASE_URL equals the local DATABASE_URL — refusing to sync a DB with itself.");
    process.exit(1);
  }
  return remote;
}

function rangeClause(prefix: string, args: Args, paramOffset: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = paramOffset;
  if (args.from) { parts.push(`"timestamp" >= $${n++}`); params.push(args.from); }
  if (args.to)   { parts.push(`"timestamp" <  $${n++}`); params.push(args.to); }
  const sql = parts.length ? ` ${prefix} ${parts.join(" AND ")}` : "";
  return { sql, params };
}

type Queryable = pg.Pool | { query: typeof localQuery };

async function countRows(q: Queryable, table: string, args: Args): Promise<number> {
  const { sql, params } = rangeClause("WHERE", args, 1);
  const res = await q.query(`SELECT COUNT(*)::bigint AS c FROM ${table}${sql}`, params);
  return Number(res.rows[0].c);
}

// ---------------------------------------------------------------------------
// candles_1m  — PK (currency, timestamp); keyset cursor walks that tuple.
// ---------------------------------------------------------------------------

interface Candle1mRow {
  currency: string;
  timestamp: Date;
  open: string; high: string; low: string; close: string;
  volume: string; volumeNormalized: string;
  sourceCount: number; sourceCountBaseline: number;
  sources: number; confidence: string;
  createdAt: Date; updatedAt: Date;
}

type Candle1mCursor = { currency: string; timestamp: Date } | null;

async function fetchCandles1mBatch(remote: pg.Pool, cursor: Candle1mCursor, args: Args): Promise<Candle1mRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (cursor) {
    params.push(cursor.currency, cursor.timestamp);
    where.push(`("currency","timestamp") > ($${params.length - 1}, $${params.length})`);
  }
  if (args.from) { params.push(args.from); where.push(`"timestamp" >= $${params.length}`); }
  if (args.to)   { params.push(args.to);   where.push(`"timestamp" <  $${params.length}`); }
  params.push(args.batchSize);
  const limitParam = params.length;

  const res = await remote.query(
    `SELECT "currency","timestamp","open","high","low","close","volume","volumeNormalized",
            "sourceCount","sourceCountBaseline","sources","confidence",
            "createdAt","updatedAt"
       FROM candles_1m
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY "currency" ASC, "timestamp" ASC
       LIMIT $${limitParam}`,
    params,
  );
  return res.rows as Candle1mRow[];
}

async function insertCandles1mBatch(rows: Candle1mRow[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await localQuery(
    `INSERT INTO candles_1m (
       "currency","timestamp","open","high","low","close","volume","volumeNormalized",
       "sourceCount","sourceCountBaseline","sources","confidence","createdAt","updatedAt"
     )
     SELECT * FROM unnest(
       $1::varchar[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[],
       $6::numeric[], $7::numeric[], $8::numeric[], $9::smallint[], $10::smallint[],
       $11::integer[], $12::numeric[], $13::timestamptz[], $14::timestamptz[]
     )
     ON CONFLICT ("currency","timestamp") DO NOTHING`,
    [
      rows.map(r => r.currency),
      rows.map(r => r.timestamp),
      rows.map(r => r.open),
      rows.map(r => r.high),
      rows.map(r => r.low),
      rows.map(r => r.close),
      rows.map(r => r.volume),
      rows.map(r => r.volumeNormalized),
      rows.map(r => r.sourceCount),
      rows.map(r => r.sourceCountBaseline),
      rows.map(r => r.sources),
      rows.map(r => r.confidence),
      rows.map(r => r.createdAt),
      rows.map(r => r.updatedAt),
    ],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// candles_1m_sources  — PK (currency, timestamp, source).
// ---------------------------------------------------------------------------

interface SourceRow {
  currency: string;
  timestamp: Date;
  source: string;
  open: string; high: string; low: string; close: string; volume: string;
  rejected: boolean;
  rejectedReason: string | null;
}

type SourceCursor = { currency: string; timestamp: Date; source: string } | null;

async function fetchSourcesBatch(remote: pg.Pool, cursor: SourceCursor, args: Args): Promise<SourceRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (cursor) {
    params.push(cursor.currency, cursor.timestamp, cursor.source);
    where.push(`("currency","timestamp","source") > ($${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  if (args.from) { params.push(args.from); where.push(`"timestamp" >= $${params.length}`); }
  if (args.to)   { params.push(args.to);   where.push(`"timestamp" <  $${params.length}`); }
  params.push(args.batchSize);
  const limitParam = params.length;

  const res = await remote.query(
    `SELECT "currency","timestamp","source","open","high","low","close","volume",
            "rejected","rejectedReason"
       FROM candles_1m_sources
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY "currency" ASC, "timestamp" ASC, "source" ASC
       LIMIT $${limitParam}`,
    params,
  );
  return res.rows as SourceRow[];
}

async function insertSourcesBatch(rows: SourceRow[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await localQuery(
    `INSERT INTO candles_1m_sources (
       "currency","timestamp","source","open","high","low","close","volume","rejected","rejectedReason"
     )
     SELECT * FROM unnest(
       $1::varchar[], $2::timestamptz[], $3::varchar[], $4::numeric[], $5::numeric[],
       $6::numeric[], $7::numeric[], $8::numeric[], $9::boolean[], $10::varchar[]
     )
     ON CONFLICT ("currency","timestamp","source") DO NOTHING`,
    [
      rows.map(r => r.currency),
      rows.map(r => r.timestamp),
      rows.map(r => r.source),
      rows.map(r => r.open),
      rows.map(r => r.high),
      rows.map(r => r.low),
      rows.map(r => r.close),
      rows.map(r => r.volume),
      rows.map(r => r.rejected),
      rows.map(r => r.rejectedReason),
    ],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// stable_rates_1m_sources  — currency-agnostic, PK (timestamp, source).
// ---------------------------------------------------------------------------

interface StableRateRow {
  timestamp: Date;
  source: string;
  rate: string;
  pegSourcePair: string;
  rejected: boolean;
  rejectedReason: string | null;
}

type StableRateCursor = { timestamp: Date; source: string } | null;

async function fetchStableRatesBatch(remote: pg.Pool, cursor: StableRateCursor, args: Args): Promise<StableRateRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (cursor) {
    params.push(cursor.timestamp, cursor.source);
    where.push(`("timestamp","source") > ($${params.length - 1}, $${params.length})`);
  }
  if (args.from) { params.push(args.from); where.push(`"timestamp" >= $${params.length}`); }
  if (args.to)   { params.push(args.to);   where.push(`"timestamp" <  $${params.length}`); }
  params.push(args.batchSize);
  const limitParam = params.length;

  const res = await remote.query(
    `SELECT "timestamp","source","rate","pegSourcePair","rejected","rejectedReason"
       FROM stable_rates_1m_sources
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY "timestamp" ASC, "source" ASC
       LIMIT $${limitParam}`,
    params,
  );
  return res.rows as StableRateRow[];
}

async function insertStableRatesBatch(rows: StableRateRow[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await localQuery(
    `INSERT INTO stable_rates_1m_sources (
       "timestamp","source","rate","pegSourcePair","rejected","rejectedReason"
     )
     SELECT * FROM unnest(
       $1::timestamptz[], $2::varchar[], $3::numeric[], $4::varchar[], $5::boolean[], $6::varchar[]
     )
     ON CONFLICT ("timestamp","source") DO NOTHING`,
    [
      rows.map(r => r.timestamp),
      rows.map(r => r.source),
      rows.map(r => r.rate),
      rows.map(r => r.pegSourcePair),
      rows.map(r => r.rejected),
      rows.map(r => r.rejectedReason),
    ],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

async function syncCandles1m(remote: pg.Pool, args: Args): Promise<void> {
  console.log("\n[candles_1m] counting...");
  const [remoteCount, localCount] = await Promise.all([
    countRows(remote,                "candles_1m", args),
    countRows({ query: localQuery }, "candles_1m", args),
  ]);
  console.log(`[candles_1m] remote=${remoteCount} local=${localCount} delta(max)=${remoteCount - localCount}`);

  if (args.dryRun) return;
  if (remoteCount === 0) { console.log("[candles_1m] remote empty; nothing to do."); return; }

  let cursor: Candle1mCursor = null;
  let processed = 0;
  let inserted = 0;
  const start = Date.now();

  while (true) {
    const batch = await fetchCandles1mBatch(remote, cursor, args);
    if (!batch.length) break;
    inserted += await insertCandles1mBatch(batch);
    processed += batch.length;
    const tail = batch[batch.length - 1];
    cursor = { currency: tail.currency, timestamp: tail.timestamp };
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r[candles_1m] processed=${processed}/${remoteCount} inserted=${inserted} ` +
      `last=${tail.currency}/${tail.timestamp.toISOString()} elapsed=${elapsed}s`
    );
  }
  process.stdout.write("\n");
  console.log(`[candles_1m] done. processed=${processed} inserted=${inserted}`);
}

async function syncSources(remote: pg.Pool, args: Args): Promise<void> {
  console.log("\n[candles_1m_sources] counting...");
  const [remoteCount, localCount] = await Promise.all([
    countRows(remote,                "candles_1m_sources", args),
    countRows({ query: localQuery }, "candles_1m_sources", args),
  ]);
  console.log(`[candles_1m_sources] remote=${remoteCount} local=${localCount} delta(max)=${remoteCount - localCount}`);

  if (args.dryRun) return;
  if (remoteCount === 0) { console.log("[candles_1m_sources] remote empty; nothing to do."); return; }

  let cursor: SourceCursor = null;
  let processed = 0;
  let inserted = 0;
  const start = Date.now();

  while (true) {
    const batch = await fetchSourcesBatch(remote, cursor, args);
    if (!batch.length) break;
    inserted += await insertSourcesBatch(batch);
    processed += batch.length;
    const tail = batch[batch.length - 1];
    cursor = { currency: tail.currency, timestamp: tail.timestamp, source: tail.source };
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r[candles_1m_sources] processed=${processed}/${remoteCount} inserted=${inserted} ` +
      `last=${tail.currency}/${tail.timestamp.toISOString()}/${tail.source} elapsed=${elapsed}s`
    );
  }
  process.stdout.write("\n");
  console.log(`[candles_1m_sources] done. processed=${processed} inserted=${inserted}`);
}

async function syncStableRates(remote: pg.Pool, args: Args): Promise<void> {
  console.log("\n[stable_rates_1m_sources] counting...");
  const [remoteCount, localCount] = await Promise.all([
    countRows(remote,                "stable_rates_1m_sources", args),
    countRows({ query: localQuery }, "stable_rates_1m_sources", args),
  ]);
  console.log(`[stable_rates_1m_sources] remote=${remoteCount} local=${localCount} delta(max)=${remoteCount - localCount}`);

  if (args.dryRun) return;
  if (remoteCount === 0) { console.log("[stable_rates_1m_sources] remote empty; nothing to do."); return; }

  let cursor: StableRateCursor = null;
  let processed = 0;
  let inserted = 0;
  const start = Date.now();

  while (true) {
    const batch = await fetchStableRatesBatch(remote, cursor, args);
    if (!batch.length) break;
    inserted += await insertStableRatesBatch(batch);
    processed += batch.length;
    const tail = batch[batch.length - 1];
    cursor = { timestamp: tail.timestamp, source: tail.source };
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r[stable_rates_1m_sources] processed=${processed}/${remoteCount} inserted=${inserted} ` +
      `last=${tail.timestamp.toISOString()}/${tail.source} elapsed=${elapsed}s`
    );
  }
  process.stdout.write("\n");
  console.log(`[stable_rates_1m_sources] done. processed=${processed} inserted=${inserted}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const remoteUrl = resolveRemoteUrl();

  console.log(`synchronizeWithRemoteDb`);
  console.log(`  from:        ${args.from ?? "(unbounded)"}`);
  console.log(`  to:          ${args.to   ?? "(unbounded)"}`);
  console.log(`  batch size:  ${args.batchSize}`);
  console.log(`  sources:     ${args.skipSources ? "skip" : "include (candles_1m_sources + stable_rates_1m_sources)"}`);
  console.log(`  mode:        ${args.dryRun ? "DRY RUN" : "write"}`);

  const remote = new Pool({ connectionString: remoteUrl });
  remote.on("connect", (c) => { c.query("SET TIME ZONE 'UTC'").catch(() => { /* surfaced on first query */ }); });

  try {
    await syncCandles1m(remote, args);
    if (!args.skipSources) {
      await syncSources(remote, args);
      await syncStableRates(remote, args);
    }
  } finally {
    await Promise.allSettled([remote.end(), getLocalPool().end()]);
  }
}

main().catch((err: Error) => {
  console.error("\nsynchronizeWithRemoteDb FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
