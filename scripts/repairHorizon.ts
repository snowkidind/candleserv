/**
 * Get or set the repair horizon — how far back (days) a repair job may reach.
 *
 * Stored in the `repairHorizonDays` app_setting; read cache-free at repair time
 * (src/lib/retention.ts). The four repair-reach clamps (validateRepairWindow,
 * ensureSourceCoverage, backfillStableRates, recomposeRange) all honor it.
 *
 * Raising this lets an operator do a one-off deep backfill: repair re-fetches
 * the older window from the exchange and recomposes candles_1m (kept forever).
 * The per-venue SOURCE archive still prunes at 180d, so this does NOT grow
 * storage — and the real ceiling is whatever each exchange actually serves
 * (see cli/probe-earliest.ts), not this number.
 *
 * Usage:
 *   npx tsx scripts/repairHorizon.ts          # show current effective horizon
 *   npx tsx scripts/repairHorizon.ts 365      # set to 365 days
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

import { getPool } from "../src/db/pool";
import { setSetting } from "../src/db/appSettings";
import {
  getRepairHorizonDays,
  REPAIR_HORIZON_DEFAULT_DAYS,
  REPAIR_HORIZON_SETTING_KEY,
} from "../src/lib/retention";

async function main(): Promise<void> {
  const arg = process.argv[2];

  try {
    const current = await getRepairHorizonDays();

    if (arg === undefined) {
      const isDefault = current === REPAIR_HORIZON_DEFAULT_DAYS;
      console.log(`repair horizon: ${current} days${isDefault ? " (default)" : ""}`);
      console.log(`  setting key:  ${REPAIR_HORIZON_SETTING_KEY}`);
      console.log(`  to change:    npx tsx scripts/repairHorizon.ts <days>`);
      return;
    }

    const days = Number(arg);
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`days must be a positive integer, got: ${arg}`);
    }

    await setSetting(REPAIR_HORIZON_SETTING_KEY, String(days));
    console.log(`repair horizon: ${current} → ${days} days`);
    if (days > REPAIR_HORIZON_DEFAULT_DAYS) {
      console.log(
        `  note: source archive still prunes at ${REPAIR_HORIZON_DEFAULT_DAYS}d; repairs beyond ${REPAIR_HORIZON_DEFAULT_DAYS}d`,
      );
      console.log(
        `        re-fetch from the exchange and persist only the composite. A venue can only serve`,
      );
      console.log(
        `        what it has — confirm reach per exchange with cli/probe-earliest.ts before backfilling.`,
      );
    }
  } finally {
    await getPool().end();
  }
}

main().catch((err: Error) => {
  console.error("\nrepairHorizon FAILED:", err.message);
  process.exit(1);
});
