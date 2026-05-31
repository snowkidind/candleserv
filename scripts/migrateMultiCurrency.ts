/**
 * Multi-currency Phase 12.2 — one-time production DB migration.
 *
 * Brings an existing BTC-only candleserv DB (PK on "timestamp") up to the
 * multi-currency schema (PK leading with "currency"). Run ONCE, against the
 * live candleserv DB, WITH THE COLLECTOR STOPPED — there is no zero-downtime
 * dance here on purpose: with writes halted the heavy PK rebuild is a plain
 * transactional ALTER (no CONCURRENTLY needed), and any minutes missed during
 * the window are backfilled by the healer on restart.
 *
 * What it does (the idempotent column-add / new-table / index work is delegated
 * to the merged code's createSchema()+seedSettings() so this script never
 * duplicates DDL and can't drift from schema.ts):
 *   1. createSchema()  — ADD COLUMN "currency" to candles_1m / candles_1m_sources
 *                        / gaps; create currencies/currency_sources/etc.; swap
 *                        indexes; drop the DEFAULT-named stable FK; apply func.sql.
 *   2. seedSettings()  — seed app_settings + currencies (BTC enabled, majors off,
 *                        all currency_sources available=false).
 *   3. (this script, in ONE transaction):
 *        - drop any REMAINING stable_rates_1m_sources FK (non-default name).
 *        - rebuild candles_1m         PK  ("timestamp")            -> (currency, "timestamp").
 *        - rebuild candles_1m_sources PK  ("timestamp","source")   -> (currency, "timestamp", source).
 *        - gaps: add UNIQUE (currency,"timestamp"); drop the old "timestamp" unique.
 *        - set currencies.inceptionTs = 2012-04-18 for BTC.
 *        - flip BTC currency_sources.available/enabled = true for ALL BTC venues.
 *        - migrate app_settings 'backfillComplete' -> 'backfillComplete:BTC'.
 *
 * Safety:
 *   - DRY RUN by default. It inspects + prints the plan and exits without
 *     writing anything. Re-run with --execute to actually migrate.
 *   - Preflight FAILS LOUD if the DB isn't in the expected pre-migration shape
 *     (wrong PK columns, empty table, collector still writing, ...). Constraint
 *     NAMES are discovered at runtime — nothing is hardcoded — but the COLUMN
 *     sets are asserted.
 *   - The transform runs in a single transaction; any error rolls the whole
 *     thing back.
 *   - Re-running after a successful migration is a safe no-op (every step is
 *     guarded against its already-applied state).
 *
 * Usage:
 *   # 1. stop the collector (e.g. stop the candleserv service)
 *   # 2. snapshot first:
 *   #    pg_dump -t candles_1m -t candles_1m_sources -t gaps -t stable_rates_1m_sources "$DATABASE_URL" > candleserv_pre_mc.sql
 *   # 3. dry run — read-only, prints the plan:
 *   npx tsx scripts/migrateMultiCurrency.ts
 *   # 4. execute:
 *   npx tsx scripts/migrateMultiCurrency.ts --execute
 *
 * Flags:
 *   --execute   actually perform the migration (default is dry run)
 *   --force     skip the "collector still writing" / "empty table" safety stops
 */
process.env.TZ = "UTC"; // must be set before any Date is constructed
import dotenv from "dotenv";
dotenv.config();

import { query, withTransaction, getPool } from "../src/db/pool.js";
import { createSchema, seedSettings } from "../src/db/schema.js";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");

const BTC_INCEPTION = "2012-04-18T00:00:00Z"; // earliest BTC minute (plan §12.2)
const FRESH_WRITE_GUARD_SEC = 120; // a candle newer than this => collector likely still running

// ---- small helpers ---------------------------------------------------------

function quoteIdent(name: string): string {
  // pg identifiers: double-quote and escape embedded quotes.
  return `"${name.replace(/"/g, '""')}"`;
}

function die(msg: string): never {
  console.error(`\n[migrate] ABORT: ${msg}\n`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) die(msg);
}

type Constraint = {
  conname: string;
  contype: string; // 'p' | 'u' | 'f' | 'c' | ...
  cols: string[]; // columns in key order (null-safe -> [])
  reftable: string | null; // for FKs
};

async function constraintsFor(table: string): Promise<Constraint[]> {
  const { rows } = await query(
    `SELECT con.conname,
            con.contype::text                              AS contype,
            COALESCE(array_agg(att.attname ORDER BY u.ord)
                     FILTER (WHERE att.attname IS NOT NULL), '{}') AS cols,
            CASE WHEN con.confrelid <> 0
                 THEN con.confrelid::regclass::text END    AS reftable
       FROM pg_constraint con
       JOIN pg_class rel       ON rel.oid = con.conrelid
       JOIN pg_namespace nsp   ON nsp.oid = rel.relnamespace
       LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
       LEFT JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
      WHERE rel.relname = $1 AND nsp.nspname = 'public'
      GROUP BY con.conname, con.contype, con.confrelid`,
    [table]
  );
  return rows.map((r: any) => ({
    conname: r.conname,
    contype: r.contype,
    cols: r.cols as string[],
    reftable: r.reftable ?? null,
  }));
}

const eqCols = (a: string[], b: string[]) =>
  a.length === b.length && a.every((c, i) => c === b[i]);

async function pkOf(table: string): Promise<Constraint | undefined> {
  return (await constraintsFor(table)).find((c) => c.contype === "p");
}

async function count(table: string, where = ""): Promise<number> {
  const { rows } = await query(
    `SELECT count(*)::bigint AS n FROM ${quoteIdent(table)} ${where}`
  );
  return Number(rows[0].n);
}

// ---- preflight (read-only) -------------------------------------------------

type Preflight = {
  dbLabel: string;
  counts: { candles: number; sources: number; gaps: number };
  candlesPk: Constraint;
  sourcesPk: Constraint;
};

async function preflight(): Promise<Preflight> {
  const { rows: dbinfo } = await query(
    `SELECT current_database() AS db,
            COALESCE(host(inet_server_addr()), 'local-socket') AS host`
  );
  const dbLabel = `${dbinfo[0].db} @ ${dbinfo[0].host}`;
  console.log(`[migrate] target: ${dbLabel}`);

  // Sanity: table must exist + be non-empty (guards against the wrong DB).
  const candles = await count("candles_1m");
  console.log(`[migrate] candles_1m rows: ${candles.toLocaleString()}`);
  if (candles === 0 && !FORCE)
    die("candles_1m is empty — wrong DATABASE_URL? (use --force to override)");

  // Collector-still-running guard.
  const { rows: fresh } = await query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX("timestamp")))::int AS age_sec
       FROM candles_1m_sources`
  );
  const ageSec = fresh[0].age_sec;
  console.log(
    `[migrate] newest candles_1m_sources row is ${ageSec ?? "∞"}s old`
  );
  if (ageSec != null && ageSec < FRESH_WRITE_GUARD_SEC && !FORCE)
    die(
      `a source candle was written ${ageSec}s ago — the collector appears to be ` +
        `still running. Stop it first (or pass --force if you know it is stopped).`
    );

  const sources = await count("candles_1m_sources");
  const gaps = await count("gaps");

  // Assert the starting PK shape (column sets, not names).
  const candlesPk = await pkOf("candles_1m");
  assert(candlesPk, "candles_1m has no primary key — unexpected, refusing to guess.");
  const sourcesPk = await pkOf("candles_1m_sources");
  assert(sourcesPk, "candles_1m_sources has no primary key — refusing to guess.");

  const candlesDone = eqCols(candlesPk.cols, ["currency", "timestamp"]);
  const sourcesDone = eqCols(sourcesPk.cols, ["currency", "timestamp", "source"]);
  if (candlesDone && sourcesDone) {
    console.log(
      "[migrate] candles_1m / candles_1m_sources PKs are ALREADY composite — " +
        "looks already migrated; transform steps will no-op."
    );
  } else {
    assert(
      candlesDone || eqCols(candlesPk.cols, ["timestamp"]),
      `candles_1m PK is on [${candlesPk.cols.join(", ")}] — expected [timestamp] ` +
        `(pre-migration) or [currency, timestamp] (done). Refusing to proceed.`
    );
    assert(
      sourcesDone || eqCols(sourcesPk.cols, ["timestamp", "source"]),
      `candles_1m_sources PK is on [${sourcesPk.cols.join(", ")}] — expected ` +
        `[timestamp, source] or [currency, timestamp, source]. Refusing.`
    );
  }

  console.log(
    `\n[migrate] PLAN` +
      `\n  candles_1m         PK [${candlesPk.cols.join(", ")}] -> [currency, timestamp]` +
      `\n  candles_1m_sources PK [${sourcesPk.cols.join(", ")}] -> [currency, timestamp, source]` +
      `\n  gaps               add UNIQUE(currency, timestamp), drop old timestamp UNIQUE` +
      `\n  stable FK          drop (D-STABLE-FK)` +
      `\n  currencies         BTC inceptionTs = ${BTC_INCEPTION}` +
      `\n  currency_sources   BTC available+enabled = true for ALL BTC venues` +
      `\n  app_settings       backfillComplete -> backfillComplete:BTC` +
      `\n  rows               candles_1m=${candles.toLocaleString()} sources=${sources.toLocaleString()} gaps=${gaps.toLocaleString()}\n`
  );

  return {
    dbLabel,
    counts: { candles, sources, gaps },
    candlesPk,
    sourcesPk,
  };
}

// ---- the destructive transform ---------------------------------------------

async function migrate(pre: Preflight): Promise<void> {
  // Idempotent, no-DDL-duplication groundwork (adds columns, creates the new
  // tables, swaps indexes, drops the default-named stable FK, applies func.sql,
  // seeds app_settings + currencies). Safe to run against an initialized DB.
  console.log("[migrate] createSchema() ...");
  await createSchema();
  console.log("[migrate] seedSettings() ...");
  await seedSettings();

  // Re-discover names AFTER createSchema (it may have dropped the default FK and
  // the currency column now exists).
  const candlesPk = await pkOf("candles_1m");
  const sourcesPk = await pkOf("candles_1m_sources");
  const stableFk = (await constraintsFor("stable_rates_1m_sources")).find(
    (c) => c.contype === "f" && c.reftable === "candles_1m_sources"
  );
  const gapsCons = await constraintsFor("gaps");
  const oldGapsUnique = gapsCons.find(
    (c) => c.contype === "u" && eqCols(c.cols, ["timestamp"])
  );
  const newGapsUnique = gapsCons.find(
    (c) => c.contype === "u" && eqCols(c.cols, ["currency", "timestamp"])
  );

  await withTransaction(async (c) => {
    // 1. Remaining stable FK (non-default name; default one is gone via createSchema).
    if (stableFk) {
      console.log(`[migrate] DROP FK ${stableFk.conname} on stable_rates_1m_sources`);
      await c.query(
        `ALTER TABLE stable_rates_1m_sources DROP CONSTRAINT ${quoteIdent(stableFk.conname)}`
      );
    } else {
      console.log("[migrate] stable FK already absent — skip");
    }

    // 2. candles_1m PK -> (currency, timestamp)
    if (candlesPk && eqCols(candlesPk.cols, ["timestamp"])) {
      console.log(
        `[migrate] rebuild candles_1m PK (${candlesPk.conname}) -> (currency, timestamp) [7.4M rows, be patient]`
      );
      await c.query(`ALTER TABLE candles_1m DROP CONSTRAINT ${quoteIdent(candlesPk.conname)}`);
      await c.query(`ALTER TABLE candles_1m ADD PRIMARY KEY ("currency", "timestamp")`);
    } else {
      console.log("[migrate] candles_1m PK already composite — skip");
    }

    // 3. candles_1m_sources PK -> (currency, timestamp, source)
    if (sourcesPk && eqCols(sourcesPk.cols, ["timestamp", "source"])) {
      console.log(
        `[migrate] rebuild candles_1m_sources PK (${sourcesPk.conname}) -> (currency, timestamp, source)`
      );
      await c.query(
        `ALTER TABLE candles_1m_sources DROP CONSTRAINT ${quoteIdent(sourcesPk.conname)}`
      );
      await c.query(
        `ALTER TABLE candles_1m_sources ADD PRIMARY KEY ("currency", "timestamp", "source")`
      );
    } else {
      console.log("[migrate] candles_1m_sources PK already composite — skip");
    }

    // 4. gaps: add composite unique, then drop the old single-column unique.
    if (!newGapsUnique) {
      console.log("[migrate] ADD UNIQUE(currency, timestamp) on gaps");
      await c.query(`ALTER TABLE gaps ADD UNIQUE ("currency", "timestamp")`);
    } else {
      console.log("[migrate] gaps composite UNIQUE already present — skip");
    }
    if (oldGapsUnique) {
      console.log(`[migrate] DROP old gaps UNIQUE ${oldGapsUnique.conname}`);
      await c.query(`ALTER TABLE gaps DROP CONSTRAINT ${quoteIdent(oldGapsUnique.conname)}`);
    } else {
      console.log("[migrate] old gaps timestamp UNIQUE already absent — skip");
    }

    // 5. BTC inceptionTs (seedCurrencies leaves it NULL).
    const inc = await c.query(
      `UPDATE currencies SET "inceptionTs" = $1, "updatedAt" = NOW()
        WHERE code = 'BTC' AND "inceptionTs" IS NULL`,
      [BTC_INCEPTION]
    );
    console.log(`[migrate] BTC inceptionTs set on ${inc.rowCount} row(s)`);

    // 6. Enable ALL BTC venues (seedCurrencies seeds them available=false). BTC's
    //    symbol map is ground-truth; the availability mask + auto-suspend handle a
    //    dead venue, and the operator can toggle individual feeds in the Feeds tab.
    const up = await c.query(
      `UPDATE currency_sources
          SET available = true, enabled = true, "updatedAt" = NOW()
        WHERE currency = 'BTC'`
    );
    console.log(`[migrate] BTC currency_sources enabled on ${up.rowCount} row(s) (all)`);

    // 7. global backfillComplete -> backfillComplete:BTC
    const renamed = await c.query(
      `INSERT INTO app_settings ("key", "value")
       SELECT 'backfillComplete:BTC', value FROM app_settings WHERE key = 'backfillComplete'
       ON CONFLICT ("key") DO NOTHING`
    );
    const removed = await c.query(`DELETE FROM app_settings WHERE key = 'backfillComplete'`);
    console.log(
      `[migrate] backfillComplete -> backfillComplete:BTC (inserted ${renamed.rowCount}, removed ${removed.rowCount})`
    );
  });
}

// ---- post-migration validation (fail loud) ---------------------------------

async function validate(pre: Preflight): Promise<void> {
  console.log("\n[migrate] validating ...");

  const candles = await count("candles_1m");
  const sources = await count("candles_1m_sources");
  const gaps = await count("gaps");
  assert(
    candles === pre.counts.candles,
    `candles_1m row count changed ${pre.counts.candles} -> ${candles}`
  );
  assert(
    sources === pre.counts.sources,
    `candles_1m_sources row count changed ${pre.counts.sources} -> ${sources}`
  );
  assert(gaps === pre.counts.gaps, `gaps row count changed ${pre.counts.gaps} -> ${gaps}`);

  for (const t of ["candles_1m", "candles_1m_sources", "gaps"]) {
    const n = await count(t, `WHERE currency <> 'BTC'`);
    assert(n === 0, `${t} has ${n} non-BTC rows after backfill — expected 0`);
  }

  const cpk = await pkOf("candles_1m");
  const spk = await pkOf("candles_1m_sources");
  assert(
    cpk && eqCols(cpk.cols, ["currency", "timestamp"]),
    `candles_1m PK is [${cpk?.cols.join(", ")}] — expected [currency, timestamp]`
  );
  assert(
    spk && eqCols(spk.cols, ["currency", "timestamp", "source"]),
    `candles_1m_sources PK is [${spk?.cols.join(", ")}] — expected [currency, timestamp, source]`
  );

  const { rows: btc } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE available AND enabled)::int AS enabled
       FROM currency_sources WHERE currency = 'BTC'`
  );
  assert(btc[0].total > 0, "no BTC currency_sources rows after seed — expected the BTC venue set");
  assert(
    btc[0].enabled === btc[0].total,
    `BTC has ${btc[0].enabled}/${btc[0].total} venues available+enabled — expected all`
  );

  const { rows: leftover } = await query(
    `SELECT count(*)::int AS n FROM app_settings WHERE key = 'backfillComplete'`
  );
  assert(leftover[0].n === 0, "stale 'backfillComplete' key still present");

  console.log("[migrate] validation OK");
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== candleserv multi-currency migration (Phase 12.2) ===`);
  console.log(`[migrate] mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}${FORCE ? " (--force)" : ""}`);

  const pre = await preflight();

  if (!EXECUTE) {
    console.log("[migrate] DRY RUN complete — no changes made. Re-run with --execute to migrate.\n");
    return;
  }

  await migrate(pre);
  await validate(pre);

  console.log(
    `\n[migrate] DONE. ${pre.dbLabel} is now multi-currency. ` +
      `Restart candleserv; the healer will backfill any minutes missed during the window.\n`
  );
}

main()
  .then(() => getPool().end())
  .catch(async (err) => {
    console.error("\n[migrate] FAILED:", err);
    await getPool().end();
    process.exit(1);
  });
