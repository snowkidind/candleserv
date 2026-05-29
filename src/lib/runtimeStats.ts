/**
 * Shared runtime introspection used by BOTH the localhost CLI (/internal) and the
 * authenticated admin panel (/monitor). Single source of truth so the two
 * surfaces never drift. Reads process-local memory + a couple of cheap DB counts.
 */
import { tokenBudgetMapSize } from "./demoMode.js";
import { demoRateLimitStats } from "../middleware/demoRateLimit.js";
import { lastCloseMapSize } from "./collector.js";
import { isBackfillRunning } from "./healer.js";
import { getAllClients } from "./subscriptions.js";
import { isDemoMode } from "./demoMode.js";
import { countSessions } from "../db/sessions.js";
import { redisDelByPrefix, isRedisAvailable } from "./redis.js";
import { log } from "./log.js";

export interface RuntimeSnapshot {
  uptimeSeconds: number;
  demoMode: boolean;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  demo: { tokenBudgetEntries: number; readRateLimitIps: number; pageRateLimitIps: number };
  live: { sseClients: number; lastCloseEntries: number; backfillRunning: boolean };
  sessions: { total: number; authenticated: number };
  redis: { available: boolean };
}

export async function buildRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const mem = process.memoryUsage();
  const rate = demoRateLimitStats();
  const sessions = await countSessions();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    demoMode: await isDemoMode(),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    demo: {
      tokenBudgetEntries: tokenBudgetMapSize(),
      readRateLimitIps: rate.readIps,
      pageRateLimitIps: rate.pageIps,
    },
    live: {
      sseClients: getAllClients().length,
      lastCloseEntries: lastCloseMapSize(),
      backfillRunning: isBackfillRunning(),
    },
    sessions,
    redis: { available: isRedisAvailable() },
  };
}

/** Drop the candle redis cache (candles:* keys). No-op when redis is unavailable. */
export async function flushCandleCache(): Promise<{ flushed: number; note?: string }> {
  if (!isRedisAvailable()) return { flushed: 0, note: "redis unavailable — no-op" };
  const flushed = await redisDelByPrefix("candles:");
  log(`[runtimeStats] candle cache flush — removed ${flushed} candles:* keys`);
  return { flushed };
}
