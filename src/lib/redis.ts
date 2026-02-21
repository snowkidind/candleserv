import { createClient, RedisClientType } from "redis";
import { log, logError } from "./log";

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

  const nextBoundary = Math.ceil(now / tfMs) * tfMs;
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
