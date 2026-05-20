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

export interface Formula {
  excludedSources: string[];
}

export interface ComposeMinuteOpts {
  baseline: number;
  minSources: number;
  volumeLeader?: string;
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
}

/**
 * Compose one minute from the archive. Returns a verdict describing what was
 * written. Caller pre-computes baseline / minSources / volumeLeader.
 */
export async function composeMinute(
  minuteTs: Date,
  formula: Formula,
  opts: ComposeMinuteOpts,
): Promise<ComposeMinuteResult> {
  const res = await query(
    `SELECT source, open, high, low, close, volume, rejected, "rejectedReason"
       FROM candles_1m_sources
      WHERE "timestamp" = $1`,
    [minuteTs],
  );
  const rows = res.rows as ArchiveRow[];
  const excluded = new Set(formula.excludedSources);

  const formulaExcluded = rows.filter((r) => excluded.has(r.source)).length;
  const rejectedCount = rows.filter((r) => r.rejected).length;

  // Per the plan: formula-excluded rows don't appear in the composite's
  // sourcesAttempted set at all (so they don't drag confidence down).
  // Rejected rows DO appear so buildComposite can factor them into the
  // rejectedRatio component of confidence.
  const guarded: GuardedSource[] = rows
    .filter((r) => !excluded.has(r.source))
    .map((r) => ({
      source: r.source,
      candle: {
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      },
      rejected: r.rejected,
      rejectedReason: r.rejectedReason,
    }));

  const accepted = guarded.filter((g) => !g.rejected);

  // Skip path — insufficient included-and-clean sources to compose.
  if (accepted.length < opts.minSources) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE candles_1m_sources
            SET "usedInFormula" = NULL, "updatedAt" = NOW()
          WHERE "timestamp" = $1`,
        [minuteTs],
      );
      await client.query(`DELETE FROM candles_1m WHERE "timestamp" = $1`, [minuteTs]);
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
    composite = await buildComposite(guarded, opts.baseline, opts.volumeLeader, minuteTs);
  } catch (err) {
    // Shouldn't happen given the accepted.length >= minSources check above,
    // but if buildComposite throws (e.g., all-rejected race) fall back to skip.
    logError(`[compose] buildComposite threw for ${minuteTs.toISOString()}:`, err);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE candles_1m_sources
            SET "usedInFormula" = NULL, "updatedAt" = NOW()
          WHERE "timestamp" = $1`,
        [minuteTs],
      );
      await client.query(`DELETE FROM candles_1m WHERE "timestamp" = $1`, [minuteTs]);
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
         ("timestamp","open","high","low","close","volume","volumeNormalized","sourceCount","sourceCountBaseline","sources","confidence")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT ("timestamp") DO UPDATE SET
         "open" = EXCLUDED."open", "high" = EXCLUDED."high",
         "low" = EXCLUDED."low",   "close" = EXCLUDED."close",
         "volume" = EXCLUDED."volume", "volumeNormalized" = EXCLUDED."volumeNormalized",
         "sourceCount" = EXCLUDED."sourceCount",
         "sourceCountBaseline" = EXCLUDED."sourceCountBaseline",
         "sources" = EXCLUDED."sources",
         "confidence" = EXCLUDED."confidence",
         "updatedAt" = NOW()`,
      [
        minuteTs,
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
        WHERE "timestamp" = $1`,
      [minuteTs, formula.excludedSources],
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
