import { query } from "./pool";

const RETENTION_DAYS = 90;

export async function recordError(
  service: string,
  location: string,
  message: string,
  stack?: string | null
): Promise<void> {
  try {
    // Prune old rows on insert
    await query(
      `DELETE FROM service_errors WHERE "createdAt" < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    await query(
      `INSERT INTO service_errors (service, location, message, stack) VALUES ($1, $2, $3, $4)`,
      [service, location, message, stack ?? null]
    );
  } catch {
    // Never throw from error recorder — swallow silently
  }
}

export async function getRecentErrors(opts: {
  minutes?: number;
  service?: string;
  limit?: number;
}): Promise<unknown[]> {
  const { minutes = 60, service, limit = 200 } = opts;
  const values: unknown[] = [];
  const conditions: string[] = [];
  let sql = `SELECT id, service, location, message, stack, "createdAt" FROM service_errors`;

  if (minutes > 0) {
    values.push(minutes);
    conditions.push(`"createdAt" >= NOW() - ($${values.length} || ' minutes')::interval`);
  }
  if (service) {
    values.push(service);
    conditions.push(`service = $${values.length}`);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  values.push(limit);
  sql += ` ORDER BY "createdAt" DESC LIMIT $${values.length}`;

  const res = await query(sql, values);
  return res.rows;
}
