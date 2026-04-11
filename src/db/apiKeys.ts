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

export async function listApiKeys(): Promise<Omit<ApiKeyRow, "secret" | "nonce">[]> {
  const res = await query(
    `SELECT id, label, "apiKey", enabled, "lastSeen", "createdAt", "updatedAt"
     FROM api_keys ORDER BY "createdAt" DESC`
  );
  return res.rows as Omit<ApiKeyRow, "secret" | "nonce">[];
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
