/**
 * Re-derive candles_1m rows from Feb 22 onwards using per-source data
 * in candles_1m_sources and the current composite algorithm (Option A).
 *
 * Reads all rows from candles_1m_sources >= START_DATE, reconstructs
 * GuardedSource[] for each minute, calls buildComposite, and upserts
 * the result back to candles_1m.
 *
 * Usage:
 *   npx tsx scripts/rederive.ts
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed
import dotenv from "dotenv";
dotenv.config();

import { query, getPool } from "../src/db/pool";
import { buildComposite } from "../src/lib/composite";
import type { GuardedSource } from "../src/lib/composite";
import { upsertCandle } from "../src/db/candles";
import { getEnabledCurrencies, getCurrency } from "../src/db/currencies";

const SOURCE_COUNT_BASELINE = 5;
const START_DATE = new Date("2026-02-21T17:58:00Z");
const END_DATE   = new Date("2026-02-22T00:00:00Z");

async function rederiveCurrency(currency: string): Promise<{ done: number; errors: number }> {
  const meta = await getCurrency(currency);
  const premiumEnabled = meta?.premiumEnabled ?? true;

  // Fetch all distinct timestamps that have per-source data for this currency
  const tsRes = await query(
    `SELECT DISTINCT "timestamp" FROM candles_1m_sources
     WHERE "timestamp" >= $1 AND "timestamp" < $2 AND "currency" = $3
     ORDER BY "timestamp" ASC`,
    [START_DATE, END_DATE, currency]
  );

  const timestamps: Date[] = tsRes.rows.map(
    (r: Record<string, unknown>) => new Date(r.timestamp as string)
  );

  console.log(`[${currency}] ${timestamps.length} timestamps to re-derive (premiumEnabled=${premiumEnabled}).`);

  let done = 0;
  let errors = 0;

  for (const ts of timestamps) {
    // Fetch all source rows for this (currency, timestamp)
    const srcRes = await query(
      `SELECT source, open, high, low, close, volume, rejected, "rejectedReason"
       FROM candles_1m_sources
       WHERE "timestamp" = $1 AND "currency" = $2`,
      [ts, currency]
    );

    const guarded: GuardedSource[] = srcRes.rows.map((r: Record<string, unknown>) => ({
      source: r.source as string,
      candle: {
        open:   Number(r.open),
        high:   Number(r.high),
        low:    Number(r.low),
        close:  Number(r.close),
        volume: Number(r.volume),
      },
      rejected:       Boolean(r.rejected),
      rejectedReason: (r.rejectedReason ?? null) as string | null,
    }));

    try {
      // No peg rates here — this recompose is raw-quote (mirrors the original
      // script). premiumEnabled honors the per-currency D2 toggle.
      const composite = await buildComposite(guarded, SOURCE_COUNT_BASELINE, ts, undefined, premiumEnabled, currency);
      await upsertCandle({
        currency,
        timestamp:           ts,
        open:                composite.open,
        high:                composite.high,
        low:                 composite.low,
        close:               composite.close,
        volume:              composite.volume,
        volumeNormalized:    composite.volumeNormalized,
        sourceCount:         composite.sourceCount,
        sourceCountBaseline: composite.sourceCountBaseline,
        sources:             composite.sources,
        confidence:          composite.confidence,
      });
      done++;
    } catch (err) {
      console.error(`  ✗ ${currency} ${ts.toISOString()}: ${(err as Error).message}`);
      errors++;
    }

    if ((done + errors) % 100 === 0 && done + errors > 0) {
      const pct = (((done + errors) / timestamps.length) * 100).toFixed(1);
      console.log(`  [${currency}] ${done + errors}/${timestamps.length} (${pct}%) — ${done} ok, ${errors} err`);
    }
  }

  console.log(`[${currency}] done. ${done} upserted, ${errors} errors.`);
  return { done, errors };
}

async function main(): Promise<void> {
  console.log(`\nRe-deriving candles_1m from ${START_DATE.toISOString()} to ${END_DATE.toISOString()}...\n`);

  const currencies = await getEnabledCurrencies();
  let grandDone = 0;
  let grandErrors = 0;

  try {
    for (const currency of currencies) {
      const { done, errors } = await rederiveCurrency(currency);
      grandDone += done;
      grandErrors += errors;
    }
    console.log(`\nTotal: ${grandDone} upserted, ${grandErrors} errors.\n`);
  } finally {
    await getPool().end();
  }
}

main().catch((err: Error) => {
  console.error("\n✗ FAILED:", err.message, "\n");
  process.exit(1);
});
