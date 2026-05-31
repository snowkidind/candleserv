/**
 * Reconcile the gaps table against reality: flip any gap (detected / healing /
 * unresolvable) whose minute now has a composite row in candles_1m to 'healed'.
 *
 * Why this exists: recomposeRange (POST /monitor/repair) writes candles_1m
 * directly but never touches gap state, and 'unresolvable' is terminal — the
 * hourly gap scan never revisits it. So a minute filled by a repair, or one that
 * a now-fixable peg-hole heal resolved, can linger as a stale 'unresolvable' row.
 * The hourly scan now reconciles its own window (1d) and startup reconciles 7d,
 * but strays OLDER than that need this one-shot wide sweep.
 *
 * Passive: only flips rows whose minute already has data — never resurrects a
 * still-empty gap. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/reconcileGaps.ts [days]      # default 400 (effectively all)
 *   npx tsx scripts/reconcileGaps.ts 30
 */
process.env.TZ = "UTC"; // must be set before any Date is constructed
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

import { getPool } from "../src/db/pool";
import { reconcileHealedGaps } from "../src/db/gaps";
import { getEnabledCurrencies } from "../src/db/currencies";

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 400);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`[reconcileGaps] invalid days arg: ${process.argv[2]}`);
    process.exit(1);
  }
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const currencies = await getEnabledCurrencies();
  console.log(`[reconcileGaps] window ${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)} for ${currencies.length} currenc${currencies.length === 1 ? "y" : "ies"}`);

  let total = 0;
  for (const currency of currencies) {
    const n = await reconcileHealedGaps(currency, from, to);
    total += n;
    console.log(`[reconcileGaps] ${currency}: reconciled ${n} stale gap(s)`);
  }
  console.log(`[reconcileGaps] done — ${total} gap(s) flipped to healed`);
}

main()
  .then(() => getPool().end())
  .catch(async (err) => {
    console.error("[reconcileGaps] FAILED:", err);
    await getPool().end();
    process.exit(1);
  });
