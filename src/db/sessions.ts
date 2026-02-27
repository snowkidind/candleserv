import crypto from "crypto";
import { query } from "./pool";
import { logError } from "../lib/log";

export interface SessionRow {
  id: number;
  userId: number | null;
  sessionId: string;
  createdAt: Date;
  lastSeen: Date;
}

export async function getOrCreateSession(
  sessionId: string | undefined
): Promise<{ sessionId: string; userId: number | null }> {
  if (sessionId) {
    const res = await query(
      `UPDATE sessions SET "lastSeen" = NOW() WHERE "sessionId" = $1 RETURNING *`,
      [sessionId]
    );
    if (res.rows.length) {
      return { sessionId, userId: res.rows[0].userId ?? null };
    }
    // Session cookie was present but not found in DB — it was pruned or never existed.
    // A new anonymous session will be issued, overwriting the browser's cookie.
    logError(`[sessions] session not found in DB: ${sessionId.slice(0, 8)}… — issuing new anonymous session (browser will lose auth)`);
  }
  const newId = crypto.randomBytes(24).toString("hex");
  await query(
    `INSERT INTO sessions ("sessionId") VALUES ($1)`,
    [newId]
  );
  return { sessionId: newId, userId: null };
}

export async function assignUserToSession(sessionId: string, userId: number): Promise<void> {
  await query(
    `UPDATE sessions SET "userId" = $1, "lastSeen" = NOW() WHERE "sessionId" = $2`,
    [userId, sessionId]
  );
}

export async function clearUserFromSession(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET "userId" = null, "lastSeen" = NOW() WHERE "sessionId" = $1`,
    [sessionId]
  );
}

export async function getSessionUserId(sessionId: string): Promise<number | null> {
  const res = await query(
    `SELECT "userId" FROM sessions WHERE "sessionId" = $1`,
    [sessionId]
  );
  if (!res.rows.length) return null;
  return res.rows[0].userId ?? null;
}

export async function pruneOldSessions(): Promise<void> {
  // Unauthenticated sessions older than 24h, authenticated older than 7d
  await query(`
    DELETE FROM sessions WHERE
      ("userId" IS NULL AND "lastSeen" < NOW() - INTERVAL '24 hours')
      OR
      ("userId" IS NOT NULL AND "lastSeen" < NOW() - INTERVAL '7 days')
  `);
}
