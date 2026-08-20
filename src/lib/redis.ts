import { createClient, RedisClientType } from "redis";
import { log, logError } from "./log.js";

let client: RedisClientType | null = null;
let available = false;

export async function initRedis(): Promise<void> {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    const c = createClient({ url }) as RedisClientType;
    c.on("error", () => { available = false; });
    c.on("ready", () => { available = true; });
    await c.connect();
    client = c;
    available = true;
    log(`[redis] connected: ${url}`);
  } catch {
    client = null;
    available = false;
    log("[redis] not available — cache bypassed");
  }
}

export function isRedisAvailable(): boolean {
  return available && client !== null;
}

export async function redisGet(key: string): Promise<string | null> {
  if (!client || !available) return null;
  try {
    return await client.get(key);
  } catch {
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!client || !available) return;
  try {
    await client.set(key, value, { EX: ttlSeconds });
  } catch {
    // Non-fatal
  }
}

export async function redisDel(key: string): Promise<void> {
  if (!client || !available) return;
  try {
    await client.del(key);
  } catch {
    // Non-fatal
  }
}

/**
 * Delete every Redis key matching `${prefix}*`. Used to flush the candles
 * cache after a repair job (recomposeRange rewrites candles_1m, but the
 * existing live-tick invalidator only clears `candles:latest:*` keys —
 * historical responses cached under `candles:${tf}:${endingAt}:${n}` stay
 * stale for up to 24h otherwise). Non-fatal: silently no-ops when Redis is
 * unavailable.
 */
export async function redisDelByPrefix(prefix: string): Promise<number> {
  if (!client || !available) return 0;
  try {
    const keys = await client.keys(`${prefix}*`);
    if (!keys.length) return 0;
    await client.del(keys);
    return keys.length;
  } catch {
    return 0;
  }
}

// ── Auto-ban overlay ─────────────────────────────────────────────────────────
// Ephemeral, GLOBAL (cross-currency), live-collector-only liveness state. The
// rolling-24h per-source failure record + the suspended set live here, NOT in
// formula_changes (which is durable operator intent) and NOT in the per-currency
// formula timeline (which is history). Same threshold-10 / 24h policy. The
// durable "auto-banned at T" audit stays in the DB (recordError / admin_actions). ONLY the live collector subtracts this
// overlay; recompose / heal / repair ignore it (they fix the gap a ban caused).
const AUTOBAN_FAIL_PREFIX = "candleserv:autoban:fail:";   // sorted set per source (score = failure ts)
const AUTOBAN_SUSPEND_KEY = "candleserv:autoban:suspended"; // hash: field=source → JSON SuspendInfo
const AUTOBAN_WINDOW_MS   = 24 * 60 * 60 * 1000;
let failSeq = 0; // disambiguates same-ms failures as unique sorted-set members

export interface SuspendInfo {
  reason: string;
  since: number;          // epoch ms
  by: string;
  stats: unknown;         // statsAtExclusion snapshot
}

/** Record one failure for a source into its rolling-24h window. */
export async function recordSourceFailure(source: string): Promise<void> {
  if (!client || !available) return;
  const now = Date.now();
  const key = AUTOBAN_FAIL_PREFIX + source;
  await client.zAdd(key, [{ score: now, value: `${now}:${failSeq++}` }]);
  await client.zRemRangeByScore(key, 0, now - AUTOBAN_WINDOW_MS);
  await client.expire(key, Math.ceil(AUTOBAN_WINDOW_MS / 1000) + 3600);
}

/** Failures for a source within the last 24h (evicts stale entries first). */
export async function getSourceFailureCount(source: string): Promise<number> {
  if (!client || !available) return 0;
  const now = Date.now();
  const key = AUTOBAN_FAIL_PREFIX + source;
  await client.zRemRangeByScore(key, 0, now - AUTOBAN_WINDOW_MS);
  return client.zCard(key);
}

/** Mark a source auto-suspended (live-collector liveness gate). */
export async function suspendSource(source: string, info: SuspendInfo): Promise<void> {
  if (!client || !available) return;
  await client.hSet(AUTOBAN_SUSPEND_KEY, source, JSON.stringify(info));
}

/** Clear a source's auto-suspend AND its failure window (recovery / manual resume). */
export async function unsuspendSource(source: string): Promise<void> {
  if (!client || !available) return;
  await client.hDel(AUTOBAN_SUSPEND_KEY, source);
  await client.del(AUTOBAN_FAIL_PREFIX + source);
}

export async function isSourceSuspended(source: string): Promise<boolean> {
  if (!client || !available) return false;
  return (await client.hExists(AUTOBAN_SUSPEND_KEY, source)) === true;
}

/** The whole suspended set: source → SuspendInfo. */
export async function getSuspendedSources(): Promise<Record<string, SuspendInfo>> {
  if (!client || !available) return {};
  const raw = await client.hGetAll(AUTOBAN_SUSPEND_KEY);
  const out: Record<string, SuspendInfo> = {};
  for (const [src, json] of Object.entries(raw)) {
    try { out[src] = JSON.parse(json) as SuspendInfo; } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Compute TTL (seconds) until the next boundary for a given TF.
 * Historical queries that cannot overlap with the current open candle
 * receive a 24h TTL instead.
 */
export function boundaryTtl(tf: string, endingAt?: Date): number {
  const now = Date.now();

  // If endingAt is in the past by more than one TF period, it's purely historical
  if (endingAt) {
    const tfMs = tfToMs(tf);
    if (now - endingAt.getTime() > tfMs) {
      return 24 * 60 * 60; // 24 hours for historical
    }
  }

  const tfMs = tfToMs(tf);
  if (tfMs === 0) return 60;

  // Weekly folds on Monday 00:00 UTC (WEEK_ANCHOR_MS = 4 days past the Thursday epoch); every other
  // TF is epoch-aligned. Mirrors the aggregation anchor in db/candles.ts so the forming weekly
  // candle's cache expires at the real Monday close, not the epoch's Thursday.
  const WEEK_ANCHOR_MS = 345_600_000;
  const anchorMs = tf === "7d" ? WEEK_ANCHOR_MS : 0;
  const nextBoundary = Math.ceil((now - anchorMs) / tfMs) * tfMs + anchorMs;
  const ttlMs = nextBoundary - now;
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function tfToMs(tf: string): number {
  const map: Record<string, number> = {
    "1m":  60_000,
    "5m":  5 * 60_000,
    "10m": 10 * 60_000,
    "15m": 15 * 60_000,
    "1h":  60 * 60_000,
    "2h":  2 * 60 * 60_000,
    "4h":  4 * 60 * 60_000,
    "6h":  6 * 60 * 60_000,
    "12h": 12 * 60 * 60_000,
    "1d":  24 * 60 * 60_000,
    "3d":  3 * 24 * 60 * 60_000,
    "7d":  7 * 24 * 60 * 60_000,
    "30d": 30 * 24 * 60 * 60_000,
  };
  return map[tf] ?? 0;
}
