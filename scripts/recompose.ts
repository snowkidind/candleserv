/**
 * Recompose-only — re-derive candles_1m composites from the data ALREADY in the
 * archive + stable_rates over a window, with a chosen venue set. NO exchange
 * fetches: pure DB (recomposeRange / composeMinute). Use to rebuild the index
 * after the source/pegs are already in place — e.g. after a stables backfill, or
 * to re-derive a window with a different venue set.
 *
 * Does NOT engage the repair lock (it's not a repair job) and does NOT fetch.
 * Honors the repairHorizonDays clamp (recomposeRange). Window is half-open
 * [from, to).
 *
 * Usage:
 *   npx tsx scripts/recompose.ts <CURRENCY> <fromISO> <toISO> [src1,src2,...]
 *
 *   # TON deep window, compose from binance+bybit only:
 *   npx tsx scripts/recompose.ts TON 2025-12-01T00:00:00Z 2026-03-12T00:00:00Z binance,bybit
 *
 *   # omit the source list to compose from every known venue
 *   npx tsx scripts/recompose.ts TON 2025-12-01T00:00:00Z 2026-03-12T00:00:00Z
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

import { getPool } from "../src/db/pool";
import { recomposeRange } from "../src/lib/repair";
import { SOURCE_NAMES } from "../src/adapters/registry";

async function main(): Promise<void> {
  const [currencyArg, fromArg, toArg, srcArg] = process.argv.slice(2);
  if (!currencyArg || !fromArg || !toArg) {
    console.error("usage: npx tsx scripts/recompose.ts <CURRENCY> <fromISO> <toISO> [src1,src2,...]");
    process.exit(1);
  }

  const currency = currencyArg.toUpperCase();
  const from = new Date(fromArg);
  const to   = new Date(toArg);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new Error(`from/to must be valid ISO timestamps`);
  if (to.getTime() <= from.getTime()) throw new Error(`to must be strictly after from`);

  // Build the per-op formula: compose ONLY from the included venues (exclude the
  // rest). Default = every known venue.
  const included = srcArg ? srcArg.split(",").map((s) => s.trim()).filter(Boolean) : [...SOURCE_NAMES];
  const unknown = included.filter((s) => !SOURCE_NAMES.includes(s));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")} (known: ${SOURCE_NAMES.join(", ")})`);
  const excludedSources = SOURCE_NAMES.filter((s) => !included.includes(s));

  console.log(`recompose ${currency} ${from.toISOString()} → ${to.toISOString()}`);
  console.log(`  compose from: ${included.join(", ")}${excludedSources.length ? `   (excluded: ${excludedSources.join(", ")})` : ""}`);

  try {
    const res = await recomposeRange(currency, from, to, { formula: { excludedSources } });
    console.log(
      `done: recomposed=${res.recomposed} skippedNoSources=${res.skippedNoSources} failed=${res.failed}` +
      (res.clamped ? `  clamped=${JSON.stringify(res.clamped)}` : ""),
    );
  } finally {
    await getPool().end();
  }
}

main().catch((err: Error) => {
  console.error(`\nrecompose FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
