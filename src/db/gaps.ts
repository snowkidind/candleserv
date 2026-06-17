import { query } from "./pool.js";
import type { GapRow } from "../types/index.js";

function rowToGap(row: Record<string, unknown>): GapRow {
  return {
    id: row.id as number,
    currency: row.currency as string,
    timestamp: row.timestamp as Date,
    durationMinutes: row.durationMinutes as number,
    state: row.state as string,
    sourcesAvailable: row.sourcesAvailable as number,
    alertSent: row.alertSent as boolean,
    detectedAt: row.detectedAt as Date,
    healedAt: (row.healedAt as Date) ?? null,
    updatedAt: row.updatedAt as Date,
  };
}

export async function upsertGap(currency: string, timestamp: Date, durationMinutes = 1): Promise<GapRow> {
  const res = await query(
    `INSERT INTO gaps ("currency", "timestamp", "durationMinutes")
     VALUES ($1, $2, $3)
     ON CONFLICT ("currency", "timestamp") DO UPDATE SET "updatedAt" = NOW()
     RETURNING *`,
    [currency, timestamp, durationMinutes]
  );
  return rowToGap(res.rows[0]);
}

export async function setGapState(id: number, state: string, sourcesAvailable?: number): Promise<void> {
  if (state === "healed") {
    await query(
      `UPDATE gaps SET state = $1, "healedAt" = NOW(), "updatedAt" = NOW() WHERE id = $2`,
      [state, id]
    );
  } else {
    await query(
      `UPDATE gaps SET state = $1, "sourcesAvailable" = COALESCE($3, "sourcesAvailable"), "updatedAt" = NOW() WHERE id = $2`,
      [state, id, sourcesAvailable ?? null]
    );
  }
}

export async function markAlertSent(id: number): Promise<void> {
  await query(`UPDATE gaps SET "alertSent" = true, "updatedAt" = NOW() WHERE id = $1`, [id]);
}

export async function getPendingGaps(currency: string): Promise<GapRow[]> {
  const res = await query(
    `SELECT * FROM gaps WHERE "currency" = $1 AND state IN ('detected','healing') ORDER BY "timestamp" ASC`,
    [currency]
  );
  return res.rows.map(rowToGap);
}

export async function getAllGaps(limit = 100, currency?: string): Promise<GapRow[]> {
  // currency optional: the global session view passes none (all currencies);
  // per-currency consumers (e.g. majorsGapSet) pass one so gaps stay attributable
  // and the row cap applies per currency rather than across the whole table.
  const res = currency
    ? await query(
        `SELECT * FROM gaps WHERE "currency" = $1 ORDER BY "timestamp" DESC LIMIT $2`,
        [currency, limit]
      )
    : await query(
        `SELECT * FROM gaps ORDER BY "timestamp" DESC LIMIT $1`,
        [limit]
      );
  return res.rows.map(rowToGap);
}

/**
 * Clear stale 'detected' gap rows after a backfill — but ONLY for minutes that
 * now actually have a composite. A blanket delete would erase the record of
 * minutes the backfill could not fill (e.g. a venue's out-of-history window),
 * leaving a true gap with no gaps-table row and no path back to detection once
 * it ages out of the scan window. The post-backfill runGapScan re-heals whatever
 * stays 'detected'.
 */
export async function clearDetectedGaps(currency: string): Promise<void> {
  await query(
    `DELETE FROM gaps
      WHERE "currency" = $1 AND state = 'detected'
        AND EXISTS (
          SELECT 1 FROM candles_1m c
           WHERE c."currency" = gaps."currency" AND c."timestamp" = gaps."timestamp"
        )`,
    [currency]
  );
}

/**
 * Reconcile gap state against reality: any gap in [from, to) whose minute now
 * has a composite row in candles_1m is flipped to 'healed'. Covers composites
 * written outside the per-minute heal accounting — recomposeRange (repair) never
 * touches this table, and a previously-'unresolvable' gap that later becomes
 * fillable is terminal so the detector never revisits it. Passive: only flips
 * rows whose minute already has data; never resurrects a still-empty gap.
 * Returns the number of rows reconciled.
 */
export async function reconcileHealedGaps(currency: string, from: Date, to: Date): Promise<number> {
  const res = await query(
    `UPDATE gaps g
        SET state = 'healed', "healedAt" = NOW(), "updatedAt" = NOW()
      WHERE g."currency" = $1
        AND g.state IN ('detected', 'healing', 'unresolvable')
        AND g."timestamp" >= $2 AND g."timestamp" < $3
        AND EXISTS (
          SELECT 1 FROM candles_1m c
           WHERE c."currency" = g."currency" AND c."timestamp" = g."timestamp"
        )`,
    [currency, from, to]
  );
  return res.rowCount ?? 0;
}

export async function countPendingGaps(): Promise<number> {
  const res = await query(
    `SELECT COUNT(*) FROM gaps WHERE state IN ('detected','healing')`
  );
  return Number(res.rows[0].count);
}
