import { EventEmitter } from "events";
import { redisDelByPrefix } from "./redis.js";
import type { CandleJson } from "../types/index.js";

/**
 * Internal event bus. The live collector emits here after each successful
 * composite write. SSE handlers subscribe to fan out to connected clients.
 */
class CandleEmitter extends EventEmitter {}

export const candleEmitter = new CandleEmitter();

// Each in-flight waitForFresh long-poll attaches one listener. Default cap of 10
// would warn under normal multi-consumer load (phaseserv + oracle + dashboards).
candleEmitter.setMaxListeners(1000);

// Cache invalidation: drops the new candle's currency `candles:latest:<currency>:*`
// keys on each new candle. Scoped by currency so an ETH candle never busts the
// BTC latest cache. Historical `candles:<currency>:*` entries are left to their
// short boundary TTL; the repair path does the full-prefix flush when it rewrites
// history.
// Extracted into a named function so closeAllListeners can re-attach it after a
// drain — without this, the first repair would silently break the cache
// invalidation that all REST consumers depend on.
function cacheInvalidationHandler() {
  return async (candle: CandleJson & { currency?: string }) => {
    const currency = candle?.currency ?? "BTC";
    await redisDelByPrefix(`candles:latest:${currency}:`);
  };
}
candleEmitter.on("candle", cacheInvalidationHandler());

// candleEmitter.emit("candle", candleJson) — fired by collector after each write
// candleEmitter.emit("source_state", { source, state, previousState, timestamp }) — fired on source transition
// candleEmitter.emit("__close__", { reason }) — fired by closeAllListeners() to drain in-flight subscribers

/**
 * Drain all in-flight candle/source_state subscribers. Called by the repair
 * job start hook: in-flight waitForFresh long-polls listen for
 * '__close__' and finish with 503; SSE consumers see a brief disconnect and
 * auto-reconnect. Without this, a long-poll attached before the repair-lock
 * middleware engaged would either hang past maxWaitMs or get resolved by a
 * live tick mid-repair, partially defeating the "no candle reads during
 * repair" guarantee.
 *
 * NOTE: The cache-invalidation listener installed below stays attached
 * across closeAll cycles so cache invalidation continues working after the
 * repair drains live consumers.
 */
export function closeAllListeners(reason: string): void {
  candleEmitter.emit("__close__", { reason });
  candleEmitter.removeAllListeners("candle");
  candleEmitter.removeAllListeners("source_state");
  // Re-install the cache invalidation listener — it must outlive any close.
  attachCacheInvalidator();
}

function attachCacheInvalidator(): void {
  candleEmitter.on("candle", cacheInvalidationHandler());
}
