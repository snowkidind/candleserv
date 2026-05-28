import { query } from "./pool.js";
import { logError } from "../lib/log.js";

export interface AdminAction {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

function rowToAction(row: Record<string, unknown>): AdminAction {
  return {
    id: row.id as number,
    actor: row.actor as string,
    action: row.action as string,
    target: (row.target as string) ?? null,
    detail: (row.detail as Record<string, unknown>) ?? null,
    createdAt: row.createdAt as Date,
  };
}

/**
 * Append an audit row for an operator/system mutation. Deliberately
 * fire-and-forget-safe: never throws, so a failure to log can't break the
 * action it's auditing. The caller doesn't await correctness of the write —
 * only that it was attempted.
 */
export async function recordAdminAction(input: {
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_actions ("actor", "action", "target", "detail")
       VALUES ($1, $2, $3, $4)`,
      [
        input.actor,
        input.action,
        input.target ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
  } catch (err) {
    logError(`[adminActions] failed to record ${input.action} by ${input.actor}:`, err);
  }
}

export async function listAdminActions(opts?: {
  limit?: number;
  action?: string;
  actor?: string;
  targetPrefix?: string;
}): Promise<AdminAction[]> {
  const limit = Math.min(opts?.limit ?? 200, 1000);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.action) { params.push(opts.action); where.push(`"action" = $${params.length}`); }
  if (opts?.actor)  { params.push(opts.actor);  where.push(`"actor" = $${params.length}`); }
  if (opts?.targetPrefix) { params.push(opts.targetPrefix + "%"); where.push(`"target" LIKE $${params.length}`); }
  params.push(limit);
  const res = await query(
    `SELECT * FROM admin_actions
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY "createdAt" DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(rowToAction);
}
