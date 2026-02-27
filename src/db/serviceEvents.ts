import { query } from "./pool";

export interface ServiceEvent {
  id: number;
  type: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  notes: string | null;
  createdAt: Date;
}

function rowToEvent(row: Record<string, unknown>): ServiceEvent {
  return {
    id: row.id as number,
    type: row.type as string,
    startedAt: row.startedAt as Date,
    endedAt: row.endedAt as Date,
    durationMinutes: row.durationMinutes as number,
    notes: row.notes as string | null,
    createdAt: row.createdAt as Date,
  };
}

export async function recordOutage(startedAt: Date, endedAt: Date, durationMinutes: number, notes?: string): Promise<void> {
  await query(
    `INSERT INTO service_events ("type", "startedAt", "endedAt", "durationMinutes", "notes")
     VALUES ('outage', $1, $2, $3, $4)`,
    [startedAt, endedAt, durationMinutes, notes ?? null]
  );
}

export async function getRecentOutages(limit = 10): Promise<ServiceEvent[]> {
  const res = await query(
    `SELECT * FROM service_events WHERE type = 'outage' ORDER BY "startedAt" DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(rowToEvent);
}

export async function getAllServiceEvents(limit = 200): Promise<ServiceEvent[]> {
  const res = await query(
    `SELECT * FROM service_events ORDER BY "startedAt" DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(rowToEvent);
}
