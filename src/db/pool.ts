import { Pool, PoolClient, QueryResult } from "pg";
import { logError } from "../lib/log.js";

let pool: Pool | undefined;

function initPool(): void {
  if (pool) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString: url,
  });
  pool.on("connect", (client) => {
    client.query("SET TIME ZONE 'UTC'").catch((err) => {
      logError("[candleserv pool] failed to set UTC timezone on new connection:", err);
    });
  });
  pool.on("error", (err: Error) => {
    logError("db/pool — unexpected pool error:", err);
  });
}

export function getPool(): Pool {
  if (!pool) initPool();
  return pool!;
}

export function query(sql: string, values?: unknown[]): Promise<QueryResult> {
  if (!pool) initPool();
  return pool!.query(sql, values);
}

export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  await c.query("BEGIN");
  try {
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
