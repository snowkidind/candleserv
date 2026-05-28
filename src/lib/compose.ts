/**
 * composeMinute — canonical Phase 3/5 compose function.
 *
 * Reads per-source rows from `candles_1m_sources` for a given minute, applies
 * the supplied formula and the existing `rejected` flags on those rows, and
 * either:
 *   - writes a composite row to `candles_1m` and updates `usedInFormula` on
 *     every archive row at that timestamp (success path), or
 *   - deletes any existing composite row and nullifies `usedInFormula` on
 *     every archive row at that timestamp (skip path).
 *
 * Both paths run in a single transaction so the invariant
 *   `usedInFormula IS NULL  ⟺  no candles_1m row exists for this timestamp`
 * holds at commit. The plan-prescribed bulk UPDATE means stale archive rows
 * left over from a prior compose pass also get their flag set correctly —
 * this is the canonical form the partial Phase 3 implementation missed.
 *
 * Caller pre-computes baseline / minSources / volumeLeader so recomposeRange
 * doesn't pay those queries per-minute over a 180-day window.
 */
import type { GuardedSource, CompositeResult } from "./composite.js";
import { buildComposite } from "./composite.js";
import { upsertCandle } from "../db/candles.js";
import { withTransaction, query } from "../db/pool.js";
import { logError } from "./log.js";
import { ADAPTER_BY_NAME } from "../adapters/registry.js";
import { recordError } from "../db/errors.js";

export interface Formula {
  excludedSources: string[];
}

export interface ComposeMinuteOpts {
  baseline: number;
  minSources: number;
  volumeLeader?: string;
  // Per-currency premium-offset toggle (currencies.premiumEnabled). Omitted →
  // buildComposite defaults true, preserving single-currency behavior.
  premiumEnabled?: boolean;
}

export interface ComposeMinuteResult {
  composed: boolean;        // true if a composite was written, false on skip path
  sourcesInArchive: number; // total per-source rows at this minute
  contributing: number;     // rows that actually contributed to the composite (0 if skipped)
  rejected: number;         // rows where rejected=true (outlier-guarded or no_data sentinel)
  formulaExcluded: number;  // rows whose source is in formula.excludedSources
  composite?: CompositeResult; // populated on success path so callers can emit SSE without re-querying
}

interface ArchiveRow {
  source: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  rejected: boolean;
  rejectedReason: string | null;
  stable_rate: string | null;
}

/**
 * Compose one minute from the archive. Returns a verdict describing what was
 * written. Caller pre-computes baseline / minSources / volumeLeader.
 */
export async function composeMinute(
  currency: string,
  minuteTs: Date,
  formula: Formula,
  opts: ComposeMinuteOpts,
): Promise<ComposeMinuteResult> {
  // Single JOIN: pulls the per-source candle and its paired stable rate
  // (NULL for USD-native venues, and — by the bundle invariant — NEVER NULL
  // for a non-rejected USDT BTC row, since the FK + collector transaction
  // guarantee both halves commit together). See plan:
  // candleserv-stablecoin-aware-index §Phase 2.
  const res = await query(
    `SELECT s.source, s.open, s.high, s.low, s.close, s.volume,
            s.rejected, s."rejectedReason",
            r.rate AS stable_rate
       FROM candles_1m_sources s
       LEFT JOIN stable_rates_1m_sources r
         ON r."timestamp" = s."timestamp" AND r.source = s.source
      WHERE s."timestamp" = $1 AND s."currency" = $2`,
    [minuteTs, currency],
  );
  const rows = res.rows as ArchiveRow[];
  const excluded = new Set(formula.excludedSources);

  const formulaExcluded = rows.filter((r) => excluded.has(r.source)).length;

  // Per the plan: formula-excluded rows don't appear in the composite's
  // sourcesAttempted set at all (so they don't drag confidence down).
  // Rejected rows DO appear so buildComposite can factor them into the
  // rejectedRatio component of confidence.
  //
  // Build guarded + pegRates in one pass; detect invariant violations
  // (a USDT venue's non-rejected BTC row without its paired rate row —
  // possible only via direct DB manipulation, treated as operator error
  // and dropped from this minute's composite with a loud recordError).
  const pegRates = new Map<string, number>();
  const guarded: GuardedSource[] = [];
  for (const r of rows) {
    if (excluded.has(r.source)) continue;

    const adapter = ADAPTER_BY_NAME[r.source];
    const isUsdtVenue = adapter?.normalize.pegFetcher != null;
    const rate = r.stable_rate == null ? null : Number(r.stable_rate);

    let rejected = r.rejected;
    let rejectedReason = r.rejectedReason;
    if (isUsdtVenue && !rejected && rate == null) {
      rejected = true;
      rejectedReason = "missing_paired_rate";
      await recordError(
        "compose", "invariant_violation:missing_paired_rate",
        `USDT venue ${r.source} has ${currency} row at ${minuteTs.toISOString()} without paired stable rate row — dropping from composite`,
      );
    }

    if (isUsdtVenue && rate != null) {
      pegRates.set(r.source, rate);
    }

    guarded.push({
      source: r.source,
      candle: {
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      },
      rejected,
      rejectedReason,
    });
  }

  const rejectedCount = guarded.filter((g) => g.rejected).length;
  const accepted = guarded.filter((g) => !g.rejected);

  // Skip path — insufficient included-and-clean sources to compose.
  if (accepted.length < opts.minSources) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE candles_1m_sources
            SET "usedInFormula" = NULL, "updatedAt" = NOW()
          WHERE "timestamp" = $1 AND "currency" = $2`,
        [minuteTs, currency],
      );
      await client.query(`DELETE FROM candles_1m WHERE "timestamp" = $1 AND "currency" = $2`, [minuteTs, currency]);
    });
    return {
      composed: false,
      sourcesInArchive: rows.length,
      contributing: 0,
      rejected: rejectedCount,
      formulaExcluded,
    };
  }

  // Success path — buildComposite produces the OHLCV + bitmask.
  let composite;
  try {
    composite = await buildComposite(guarded, opts.baseline, minuteTs, pegRates, opts.premiumEnabled);
  } catch (err) {
    // Shouldn't happen given the accepted.length >= minSources check above,
    // but if buildComposite throws (e.g., all-rejected race) fall back to skip.
    logError(`[compose] buildComposite threw for ${minuteTs.toISOString()}:`, err);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE candles_1m_sources
            SET "usedInFormula" = NULL, "updatedAt" = NOW()
          WHERE "timestamp" = $1 AND "currency" = $2`,
        [minuteTs, currency],
      );
      await client.query(`DELETE FROM candles_1m WHERE "timestamp" = $1 AND "currency" = $2`, [minuteTs, currency]);
    });
    return {
      composed: false,
      sourcesInArchive: rows.length,
      contributing: 0,
      rejected: rejectedCount,
      formulaExcluded,
    };
  }

  // Build the exclusion array as a literal for ALL(...) so the UPDATE picks
  // up formula-excluded sources correctly.
  await withTransaction(async (client) => {
    // upsertCandle uses its own pool query — duplicate the SQL inline so it
    // participates in the transaction.
    await client.query(
      `INSERT INTO candles_1m
         ("currency","timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT ("currency","timestamp") DO UPDATE SET
         "open" = EXCLUDED."open", "high" = EXCLUDED."high",
         "low" = EXCLUDED."low",   "close" = EXCLUDED."close",
         "volume" = EXCLUDED."volume", "volumeNormalized" = EXCLUDED."volumeNormalized",
         "sourceCount" = EXCLUDED."sourceCount",
         "sourceCountBaseline" = EXCLUDED."sourceCountBaseline",
         "sources" = EXCLUDED."sources",
         "confidence" = EXCLUDED."confidence",
         "updatedAt" = NOW()`,
      [
        currency, minuteTs,
        composite.open, composite.high, composite.low, composite.close,
        composite.volume, composite.volumeNormalized,
        composite.sourceCount, composite.sourceCountBaseline,
        composite.sources, composite.confidence,
      ],
    );
    // Single bulk UPDATE: every archive row at the minute gets its
    // usedInFormula set based on (NOT excluded AND NOT rejected). Plan-canonical
    // form — fixes the stale-NULL leftover problem from Phase 3.
    await client.query(
      `UPDATE candles_1m_sources
          SET "usedInFormula" = (source != ALL($2::varchar[]) AND rejected = false),
              "updatedAt" = NOW()
        WHERE "timestamp" = $1 AND "currency" = $3`,
      [minuteTs, formula.excludedSources, currency],
    );
  });

  return {
    composed: true,
    sourcesInArchive: rows.length,
    contributing: composite.sourceCount,
    rejected: rejectedCount,
    formulaExcluded,
    composite,
  };
}

// Re-export so callers don't need a separate import line.
export { upsertCandle };
