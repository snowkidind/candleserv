/**
 * Detect and heal missing candle minutes in the last N days.
 *
 * Bypasses the ">100 pending gaps → defer to backfill" guard in
 * gapDetector.healPendingGaps that prevents the hourly scan from touching
 * multi-hour outages on a prod instance where backfillComplete=true.
 *
 * For each contiguous block of missing minutes, calls healRange(from, to, true)
 * — which fetches from all five exchanges in tiles, applies guards
 * (applyGuards: minSources, sigma close-outlier rejection), and writes a
 * composite row via buildComposite (with confidence score + trailing volume
 * leader normalization).
 *
 * Also keeps the `gaps` table coherent: any filled minute is marked 'healed',
 * any minute all five exchanges refused is marked 'unresolvable'.
 *
 * Usage:
 *   npx tsx scripts/healGaps.ts [days]          # default 7
 *   npx tsx scripts/healGaps.ts 14
 *   npx tsx scripts/healGaps.ts 7 --dry-run     # report only, no network/writes
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

import { query, getPool } from "../src/db/pool";
import { healRange } from "../src/lib/healer";
import { upsertGap, setGapState } from "../src/db/gaps";

interface Range {
  from: Date;
  to: Date;
  minutes: Date[];
}

function parseArgs(): { days: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const days = positional.length ? Number(positional[0]) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid days argument: ${positional[0]}`);
  }
  return { days, dryRun };
}

async function findMissingMinutes(from: Date, to: Date): Promise<Date[]> {
  const res = await query(
    `SELECT gs AS expected_ts
     FROM generate_series($1::timestamptz, $2::timestamptz - INTERVAL '1 minute', INTERVAL '1 minute') gs
     LEFT JOIN candles_1m c ON c."timestamp" = gs
     WHERE c."timestamp" IS NULL
     ORDER BY gs ASC`,
    [from, to]
  );
  return res.rows.map((r: Record<string, unknown>) => new Date(r.expected_ts as string));
}

function groupIntoRanges(timestamps: Date[]): Range[] {
  if (!timestamps.length) return [];
  const ranges: Range[] = [];
  let block: Date[] = [timestamps[0]];
  let prev = timestamps[0];

  for (let i = 1; i < timestamps.length; i++) {
    const curr = timestamps[i];
    if (curr.getTime() - prev.getTime() > 2 * 60000) {
      ranges.push({ from: block[0], to: new Date(prev.getTime() + 60000), minutes: block });
      block = [curr];
    } else {
      block.push(curr);
    }
    prev = curr;
  }
  ranges.push({ from: block[0], to: new Date(prev.getTime() + 60000), minutes: block });
  return ranges;
}

async function reportConfidence(from: Date, to: Date): Promise<void> {
  const res = await query(
    `SELECT
       COUNT(*)::int                                                      AS total,
       COUNT(*) FILTER (WHERE confidence >= 1.0)::int                     AS full_confidence,
       COUNT(*) FILTER (WHERE confidence >= 0.6 AND confidence < 1.0)::int AS partial_confidence,
       COUNT(*) FILTER (WHERE confidence < 0.6)::int                      AS low_confidence,
       ROUND(AVG(confidence)::numeric, 3)                                 AS avg_confidence
     FROM candles_1m
     WHERE "timestamp" >= $1 AND "timestamp" < $2`,
    [from, to]
  );
  const r = res.rows[0];
  console.log(`  window rows:       ${r.total}`);
  console.log(`  avg confidence:    ${r.avg_confidence}`);
  console.log(`  full (5/5):        ${r.full_confidence}`);
  console.log(`  partial (3-4/5):   ${r.partial_confidence}`);
  console.log(`  low (<3/5):        ${r.low_confidence}`);
}

async function main(): Promise<void> {
  const { days, dryRun } = parseArgs();

  const to = new Date();
  to.setSeconds(0, 0); // only scan completed minutes — never reach into the future
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`\nhealGaps: scanning ${from.toISOString()} → ${to.toISOString()} (${days}d)`);
  if (dryRun) console.log("DRY RUN — no fetches, no writes\n");

  const missing = await findMissingMinutes(from, to);
  console.log(`\nmissing minutes: ${missing.length}`);

  if (!missing.length) {
    console.log("no gaps to heal.\n");
    await getPool().end();
    return;
  }

  const ranges = groupIntoRanges(missing);
  console.log(`contiguous ranges: ${ranges.length}`);
  for (const r of ranges) {
    console.log(`  ${r.from.toISOString()} → ${r.to.toISOString()}  (${r.minutes.length}m)`);
  }

  if (dryRun) {
    console.log("\n(dry-run) skipping heal. confidence snapshot for window:");
    await reportConfidence(from, to);
    console.log();
    await getPool().end();
    return;
  }

  // Register each missing minute in the gaps table so the /monitor/gaps view
  // reflects what we're doing. Mark 'healing' before the fetch.
  console.log("\nregistering gap rows...");
  const gapIdsByMinute = new Map<number, number>();
  for (const ts of missing) {
    const row = await upsertGap("BTC", ts);
    gapIdsByMinute.set(ts.getTime(), row.id);
    await setGapState(row.id, "healing");
  }

  let totalHealed = 0;
  let totalUnresolvable = 0;

  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    console.log(
      `\n[${i + 1}/${ranges.length}] healing ${r.from.toISOString()} → ${r.to.toISOString()} (${r.minutes.length}m)`
    );

    const written = await healRange("BTC", r.from, r.to, true);

    let healed = 0;
    let unresolvable = 0;
    for (const ts of r.minutes) {
      const id = gapIdsByMinute.get(ts.getTime());
      if (id == null) throw new Error(`missing gap id for ${ts.toISOString()}`);
      if (written.has(ts.getTime())) {
        await setGapState(id, "healed");
        healed++;
      } else {
        await setGapState(id, "unresolvable");
        unresolvable++;
        console.error(`  unresolvable: ${ts.toISOString()}`);
      }
    }

    console.log(`  → healed=${healed} unresolvable=${unresolvable}`);
    totalHealed += healed;
    totalUnresolvable += unresolvable;
  }

  console.log(`\nsummary: healed=${totalHealed} unresolvable=${totalUnresolvable} of ${missing.length}`);
  console.log("\nconfidence snapshot for window:");
  await reportConfidence(from, to);
  console.log();

  await getPool().end();
}

main().catch((err: Error) => {
  console.error("\nhealGaps FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
