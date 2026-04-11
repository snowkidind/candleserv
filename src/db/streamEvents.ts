import { query } from "./pool.js";

export async function insertStreamEvent(source: string, state: string): Promise<void> {
  await query(
    `INSERT INTO stream_events (source, state) VALUES ($1, $2)`,
    [source, state]
  );
}

export async function getStreamEvents(opts: {
  minutes?: number;
  source?: string;
  limit?: number;
}): Promise<unknown[]> {
  const { minutes = 60, source, limit = 500 } = opts;
  const values: unknown[] = [];
  const conditions: string[] = [];
  let sql = `SELECT id, source, state, "createdAt" FROM stream_events`;

  if (minutes > 0) {
    values.push(minutes);
    conditions.push(`"createdAt" >= NOW() - ($${values.length} || ' minutes')::interval`);
  }
  if (source) {
    values.push(source);
    conditions.push(`source = $${values.length}`);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  values.push(limit);
  sql += ` ORDER BY "createdAt" ASC LIMIT $${values.length}`;

  const res = await query(sql, values);
  return res.rows;
}
