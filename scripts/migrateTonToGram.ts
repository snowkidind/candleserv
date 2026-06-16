/**
 * TON → GRAM currency rename — one-off per-node migration.
 *
 * Toncoin (`TON`) rebrands to `GRAM`. This is the SAME asset (plan decision D2),
 * so candleserv relabels its stored `TON` series to `GRAM` in place with full
 * history continuity — it does NOT create a second currency. Run ONCE per node,
 * against the live candleserv DB, WITH ALL WRITERS TO candles_1m HALTED (stop
 * the collector, pause the healer); the preflight refuses if a TON writer is
 * still live.
 *
 * What it does (ONE transaction, FK-safe insert-new → repoint-children →
 * delete-old order, plan decision D3):
 *   1. INSERT the new `GRAM` currencies row, copying TON's flags but forcing
 *      minSources = 1 for the venue-churn transition (decision D5).
 *   2. Relabel currency='TON' → 'GRAM' across the six currency-keyed candle/gap/
 *      formula tables (candles_1m, candles_1m_sources, candles_1d, candles_1w,
 *      gaps, currency_formula_versions).
 *   3. Repoint currency_sources to GRAM, flipping the two already-rebranded
 *      venues (gate → GRAM_USDT, bitget → GRAMUSDT) to their live GRAM symbols
 *      idempotently and leaving every other venue's symbol untouched (those
 *      repoint rolling in Stage 5 as each exchange lists GRAM).
 *   4. Rename app_settings keys suffixed ':TON' → ':GRAM' (backfillComplete:TON,
 *      any HEALER_PAUSE:TON, ...).
 *   5. DELETE the old `TON` parent currencies row.
 *
 * Safety:
 *   - DRY RUN by default — prints per-table TON row counts and exits writing
 *     nothing. Re-run with --execute to migrate.
 *   - Preflight FAILS LOUD: throws if `currencies` has no TON; exits as a no-op
 *     if `GRAM` already exists (already migrated); throws if the latest TON
 *     candles_1m row is newer than 90s (a TON writer is still live).
 *   - Single transaction; any error rolls the whole thing back. Each write
 *     asserts its row count and throws on an impossible zero.
 *   - --reverse runs the exact inverse (GRAM → TON) for per-node rollback.
 *
 * Usage:
 *   # 1. halt writers (stop collector, pause healer)
 *   # 2. dry run — read-only, prints the plan:
 *   npx tsx scripts/migrateTonToGram.ts
 *   # 3. execute:
 *   npx tsx scripts/migrateTonToGram.ts --execute
 *   # rollback a node:
 *   npx tsx scripts/migrateTonToGram.ts --reverse --execute
 *
 * Flags:
 *   --execute   actually perform the migration (default is dry run)
 *   --reverse   run the inverse (GRAM → TON) instead of TON → GRAM
 */
process.env.TZ = "UTC"; // must be set before any Date is constructed
import dotenv from "dotenv";
dotenv.config();

import { query, withTransaction, getPool } from "../src/db/pool.js";

const EXECUTE = process.argv.includes("--execute");
const REVERSE = process.argv.includes("--reverse");

const FRESH_WRITE_GUARD_SEC = 90; // a TON candle newer than this => a writer is still live

// Direction config. minSources is forced to the literal 1 in BOTH directions:
// forward sets GRAM to 1 for the churn transition (D5); reverse restores TON's
// pre-migration value, which was also 1 (verified in the live DB 2026-06-16) and
// is restored as a literal because the forward run deletes the TON row so the
// value can no longer be read back.
const DIR = REVERSE
  ? { from: "GRAM", to: "TON",  toDisplay: "Toncoin", gateSym: "TON_USDT",  bitgetSym: "TONUSDT" }
  : { from: "TON",  to: "GRAM", toDisplay: "GRAM",    gateSym: "GRAM_USDT", bitgetSym: "GRAMUSDT" };

// The six currency-keyed tables relabeled in bulk. candles_1m / candles_1m_sources
// / currency_formula_versions MUST have rows when the `from` currency exists, so a
// zero there is impossible and throws; candles_1d / candles_1w / gaps may legitimately
// be empty (materialized indexes hold only complete buckets; a node may have no gaps),
// so their counts are logged but not asserted.
const RELABEL_TABLES = [
  "candles_1m",
  "candles_1m_sources",
  "candles_1d",
  "candles_1w",
  "gaps",
  "currency_formula_versions",
];
const IMPOSSIBLE_ZERO = new Set(["candles_1m", "candles_1m_sources", "currency_formula_versions"]);

// ---- small helpers ---------------------------------------------------------

function die(msg: string): never {
  console.error(`\n[migrate] ABORT: ${msg}\n`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) die(msg);
}

async function currencyExists(code: string): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM currencies WHERE code = $1`, [code]);
  return rows.length > 0;
}

async function countWhereCurrency(table: string, code: string): Promise<number> {
  const { rows } = await query(`SELECT count(*)::bigint AS n FROM ${table} WHERE currency = $1`, [code]);
  return Number(rows[0].n);
}

// ---- preflight (read-only) -------------------------------------------------

// Returns false to signal a clean no-op exit (already migrated); throws via die()
// on any unexpected state.
async function preflight(): Promise<boolean> {
  const { rows: dbinfo } = await query(
    `SELECT current_database() AS db,
            COALESCE(host(inet_server_addr()), 'local-socket') AS host`
  );
  console.log(`[migrate] target: ${dbinfo[0].db} @ ${dbinfo[0].host}`);
  console.log(`[migrate] direction: ${DIR.from} -> ${DIR.to}`);

  // No-op exit if the target already exists (already migrated this direction).
  if (await currencyExists(DIR.to)) {
    console.log(`[migrate] currencies already has '${DIR.to}' — looks already migrated. No-op.`);
    return false;
  }
  // Nothing to migrate if the source row is gone — fail loud.
  if (!(await currencyExists(DIR.from))) {
    die(`currencies has no '${DIR.from}' row — nothing to migrate (wrong DB or already done?).`);
  }

  // Writer-still-running guard, narrowed to the source currency: only a
  // `from`-currency writer blocks this migration.
  const { rows: fresh } = await query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX("timestamp")))::int AS age_sec
       FROM candles_1m WHERE currency = $1`,
    [DIR.from]
  );
  const ageSec = fresh[0].age_sec;
  console.log(`[migrate] newest ${DIR.from} candles_1m row is ${ageSec ?? "∞"}s old`);
  if (ageSec != null && ageSec < FRESH_WRITE_GUARD_SEC) {
    die(
      `a ${DIR.from} candle was written ${ageSec}s ago — a writer appears to still be ` +
        `running. Halt the collector + healer first.`
    );
  }

  // Dry-run plan: per-table source-currency row counts.
  console.log(`\n[migrate] PLAN (${EXECUTE ? "EXECUTE" : "DRY RUN"})`);
  for (const t of RELABEL_TABLES) {
    const n = await countWhereCurrency(t, DIR.from);
    console.log(`  ${t.padEnd(26)} ${n.toLocaleString()} ${DIR.from} rows -> ${DIR.to}`);
  }
  const { rows: src } = await query(
    `SELECT count(*)::int AS n FROM currency_sources WHERE currency = $1`,
    [DIR.from]
  );
  console.log(`  ${"currency_sources".padEnd(26)} ${src[0].n} rows -> ${DIR.to} (gate->${DIR.gateSym}, bitget->${DIR.bitgetSym})`);
  const { rows: settings } = await query(
    `SELECT count(*)::int AS n FROM app_settings WHERE key LIKE $1`,
    [`%:${DIR.from}`]
  );
  console.log(`  ${"app_settings".padEnd(26)} ${settings[0].n} ':${DIR.from}' keys -> ':${DIR.to}'`);
  console.log(`  ${"currencies".padEnd(26)} insert ${DIR.to} (minSources=1), delete ${DIR.from}\n`);

  return true;
}

// ---- the transform ---------------------------------------------------------

async function migrate(): Promise<void> {
  await withTransaction(async (c) => {
    // 1. INSERT the new parent row, copying flags but forcing minSources = 1 (D5).
    const ins = await c.query(
      `INSERT INTO currencies (code,"displayName",enabled,"premiumEnabled","flatFillEmpty","minSources","inceptionTs","sourceRetentionDays","createdAt","updatedAt")
       SELECT $1,$2,enabled,"premiumEnabled","flatFillEmpty",1,"inceptionTs","sourceRetentionDays",NOW(),NOW()
         FROM currencies WHERE code = $3
       ON CONFLICT (code) DO NOTHING`,
      [DIR.to, DIR.toDisplay, DIR.from]
    );
    assert(ins.rowCount && ins.rowCount > 0, `INSERT currencies '${DIR.to}' affected 0 rows — '${DIR.from}' parent missing?`);
    console.log(`[migrate] INSERT currencies '${DIR.to}' (minSources=1) — ${ins.rowCount} row`);

    // 2. Relabel the six currency-keyed tables.
    for (const t of RELABEL_TABLES) {
      const up = await c.query(
        `UPDATE ${t} SET currency = $1 WHERE currency = $2`,
        [DIR.to, DIR.from]
      );
      const n = up.rowCount ?? 0;
      if (IMPOSSIBLE_ZERO.has(t)) {
        assert(n > 0, `UPDATE ${t} relabeled 0 rows — impossible while '${DIR.from}' exists.`);
      }
      console.log(`[migrate] UPDATE ${t} ${DIR.from}->${DIR.to} — ${n} row(s)`);
    }

    // 3. Repoint currency_sources, flipping the two rebranded venues idempotently.
    const cs = await c.query(
      `UPDATE currency_sources
          SET currency = $1,
              symbol = CASE source WHEN 'gate' THEN $2 WHEN 'bitget' THEN $3 ELSE symbol END,
              "updatedAt" = NOW()
        WHERE currency = $4`,
      [DIR.to, DIR.gateSym, DIR.bitgetSym, DIR.from]
    );
    assert(cs.rowCount && cs.rowCount > 0, `UPDATE currency_sources affected 0 rows — '${DIR.from}' venues missing?`);
    console.log(`[migrate] UPDATE currency_sources ${DIR.from}->${DIR.to} (gate->${DIR.gateSym}, bitget->${DIR.bitgetSym}) — ${cs.rowCount} row(s)`);

    // 4. Rename app_settings ':from' keys -> ':to'.
    const st = await c.query(
      `UPDATE app_settings SET key = replace(key, $1, $2), "updatedAt" = NOW() WHERE key LIKE $3`,
      [`:${DIR.from}`, `:${DIR.to}`, `%:${DIR.from}`]
    );
    assert(st.rowCount && st.rowCount > 0, `UPDATE app_settings renamed 0 ':${DIR.from}' keys — backfillComplete:${DIR.from} missing?`);
    console.log(`[migrate] UPDATE app_settings ':${DIR.from}'->':${DIR.to}' — ${st.rowCount} key(s)`);

    // 5. DELETE the old parent row.
    const del = await c.query(`DELETE FROM currencies WHERE code = $1`, [DIR.from]);
    assert(del.rowCount && del.rowCount > 0, `DELETE currencies '${DIR.from}' affected 0 rows.`);
    console.log(`[migrate] DELETE currencies '${DIR.from}' — ${del.rowCount} row`);
  });
}

// ---- post-migration validation (fail loud) ---------------------------------

async function validate(): Promise<void> {
  console.log("\n[migrate] validating ...");
  assert(await currencyExists(DIR.to), `'${DIR.to}' currencies row absent after migrate`);
  assert(!(await currencyExists(DIR.from)), `'${DIR.from}' currencies row still present after migrate`);
  const { rows } = await query(`SELECT "minSources" FROM currencies WHERE code = $1`, [DIR.to]);
  assert(Number(rows[0].minSources) === 1, `'${DIR.to}' minSources is ${rows[0].minSources} — expected 1`);
  for (const t of RELABEL_TABLES) {
    const n = await countWhereCurrency(t, DIR.from);
    assert(n === 0, `${t} still has ${n} '${DIR.from}' rows after migrate`);
  }
  console.log("[migrate] validation OK");
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== candleserv TON->GRAM migration ===`);
  console.log(`[migrate] mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}${REVERSE ? " (--reverse)" : ""}`);

  const proceed = await preflight();
  if (!proceed) return; // already migrated — clean no-op

  if (!EXECUTE) {
    console.log("[migrate] DRY RUN complete — no changes made. Re-run with --execute to migrate.\n");
    return;
  }

  await migrate();
  await validate();

  console.log(
    `\n[migrate] DONE. Data is now under '${DIR.to}'. Flush the candle cache, ` +
      `then deploy the aliased build and restart writers.\n`
  );
}

main()
  .then(() => getPool().end())
  .catch(async (err) => {
    console.error("\n[migrate] FAILED:", err);
    await getPool().end();
    process.exit(1);
  });
