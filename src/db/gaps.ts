import { query } from "./pool";
import type { GapRow } from "../types/index";

function rowToGap(row: Record<string, unknown>): GapRow {
  return {
    id: row.id as number,
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

export async function upsertGap(timestamp: Date, durationMinutes = 1): Promise<GapRow> {
  const res = await query(
    `INSERT INTO gaps ("timestamp", "durationMinutes")
     VALUES ($1, $2)
     ON CONFLICT ("timestamp") DO UPDATE SET "updatedAt" = NOW()
     RETURNING *`,
    [timestamp, durationMinutes]
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

export async function getPendingGaps(): Promise<GapRow[]> {
  const res = await query(
    `SELECT * FROM gaps WHERE state IN ('detected','healing') ORDER BY "timestamp" ASC`
  );
  return res.rows.map(rowToGap);
}

export async function getAllGaps(limit = 100): Promise<GapRow[]> {
  const res = await query(
    `SELECT * FROM gaps ORDER BY "timestamp" DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(rowToGap);
}

export async function clearDetectedGaps(): Promise<void> {
  await query(`DELETE FROM gaps WHERE state = 'detected'`);
}

export async function countPendingGaps(): Promise<number> {
  const res = await query(
    `SELECT COUNT(*) FROM gaps WHERE state IN ('detected','healing')`
  );
  return Number(res.rows[0].count);
}
