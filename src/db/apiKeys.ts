import crypto from "crypto";
import { query } from "./pool.js";
import type { ApiKeyRow } from "../types/index.js";

function rowToApiKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: row.id as number,
    label: row.label as string,
    apiKey: row.apiKey as string,
    secret: row.secret as string,
    nonce: row.nonce as bigint,
    enabled: row.enabled as boolean,
    lastSeen: row.lastSeen as Date | null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function findApiKey(apiKey: string): Promise<ApiKeyRow | null> {
  const res = await query(`SELECT * FROM api_keys WHERE "apiKey" = $1`, [apiKey]);
  if (!res.rows.length) return null;
  return rowToApiKey(res.rows[0]);
}

export async function updateApiKeyNonce(id: number, nonce: bigint): Promise<void> {
  await query(
    `UPDATE api_keys SET nonce = $1, "lastSeen" = NOW(), "updatedAt" = NOW() WHERE id = $2`,
    [nonce, id]
  );
}

/**
 * List keys for the admin UI. Strips `secret` and the raw `nonce` value
 * (no need to expose either to operators), but exposes a derived
 * `nonceStatus` so the UI can flag rows that need repair.
 *
 * 'ok'     — nonce ≤ current ms (normal: future requests can advance it)
 * 'repair' — nonce > current ms (poisoned: every legit request now 401s
 *            as a replay; operator action required)
 */
export interface ApiKeyListRow extends Omit<ApiKeyRow, "secret" | "nonce"> {
  nonceStatus: "ok" | "repair";
}

export async function listApiKeys(): Promise<ApiKeyListRow[]> {
  const nowMs = Date.now();
  const res = await query(
    `SELECT id, label, "apiKey", enabled, "lastSeen", "createdAt", "updatedAt",
            (nonce > $1) AS "needsRepair"
     FROM api_keys ORDER BY "createdAt" DESC`,
    [nowMs]
  );
  return res.rows.map(row => ({
    id:          row.id as number,
    label:       row.label as string,
    apiKey:      row.apiKey as string,
    enabled:     row.enabled as boolean,
    lastSeen:    row.lastSeen as Date | null,
    createdAt:   row.createdAt as Date,
    updatedAt:   row.updatedAt as Date,
    nonceStatus: row.needsRepair ? "repair" : "ok",
  }));
}

/**
 * Reset the nonce of one key to 0. Used by the per-row "Repair" action
 * on the admin tab.
 */
export async function repairApiKeyNonce(apiKey: string): Promise<void> {
  await query(
    `UPDATE api_keys SET nonce = 0, "updatedAt" = NOW() WHERE "apiKey" = $1`,
    [apiKey]
  );
}

/**
 * Scan + repair all rows whose nonce exceeds wall-clock ms. Returns the
 * list of repaired rows with their pre-reset nonce values for reporting.
 */
export async function findAndRepairBrokenNonces(): Promise<{ id: number; label: string; apiKey: string; oldNonce: string }[]> {
  const nowMs = Date.now();
  const res = await query(
    `WITH broken AS (
       SELECT id, label, "apiKey", nonce FROM api_keys WHERE nonce > $1
     ),
     upd AS (
       UPDATE api_keys SET nonce = 0, "updatedAt" = NOW() WHERE id IN (SELECT id FROM broken)
       RETURNING id
     )
     SELECT id, label, "apiKey", nonce FROM broken ORDER BY label`,
    [nowMs]
  );
  return res.rows.map(r => ({
    id:       r.id as number,
    label:    r.label as string,
    apiKey:   r.apiKey as string,
    oldNonce: String(r.nonce),   // bigint → string to keep precision in JSON
  }));
}

export async function createApiKey(label: string): Promise<{ apiKey: string; secret: string }> {
  const apiKey = crypto.randomBytes(9).toString("hex");   // 18 hex chars
  const secret = crypto.randomBytes(10).toString("hex");  // 20 hex chars
  await query(
    `INSERT INTO api_keys (label, "apiKey", secret) VALUES ($1, $2, $3)`,
    [label, apiKey, secret]
  );
  return { apiKey, secret };
}

export async function revokeApiKey(apiKey: string): Promise<void> {
  await query(`DELETE FROM api_keys WHERE "apiKey" = $1`, [apiKey]);
}

export async function setApiKeyEnabled(apiKey: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE api_keys SET enabled = $1, "updatedAt" = NOW() WHERE "apiKey" = $2`,
    [enabled, apiKey]
  );
}
