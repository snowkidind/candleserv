import { query } from "./pool.js";
import { logError } from "../lib/log.js";

// In-memory cache (fallback when Redis unavailable)
const cache = new Map<string, { value: string; expiresAt: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getSetting(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const res = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    if (!res.rows.length) return null;
    const value = res.rows[0].value as string;
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (err) {
    logError("[appSettings] getSetting failed:", err);
    return null;
  }
}

// Cache-free read of a setting's value + last-updated time. Used where the UI
// needs freshness + the updatedAt timestamp (e.g. the per-currency backfill
// latch on the Feeds tab); the 1h getSetting cache would mask a recent flip.
export async function getSettingMeta(key: string): Promise<{ value: string; updatedAt: Date } | null> {
  try {
    const res = await query(`SELECT value, "updatedAt" FROM app_settings WHERE key = $1`, [key]);
    if (!res.rows.length) return null;
    return { value: res.rows[0].value as string, updatedAt: res.rows[0].updatedAt as Date };
  } catch (err) {
    logError("[appSettings] getSettingMeta failed:", err);
    return null;
  }
}

export async function getSettingInt(key: string, fallback: number): Promise<number> {
  const val = await getSetting(key);
  if (val === null) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, "updatedAt") VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()`,
    [key, value]
  );
  // Invalidate cache immediately
  cache.delete(key);
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const res = await query(`SELECT key, value FROM app_settings ORDER BY key`);
  return Object.fromEntries(res.rows.map((r: { key: string; value: string }) => [r.key, r.value]));
}

export function invalidateSettingCache(key: string): void {
  cache.delete(key);
}
