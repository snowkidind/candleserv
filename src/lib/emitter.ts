import { EventEmitter } from "events";
import { redisDel } from "./redis.js";
import { VALID_TFS } from "../db/candles.js";

/**
 * Internal event bus. The live collector emits here after each successful
 * composite write. SSE handlers subscribe to fan out to connected clients.
 */
class CandleEmitter extends EventEmitter {}

export const candleEmitter = new CandleEmitter();

// Each in-flight waitForFresh long-poll attaches one listener. Default cap of 10
// would warn under normal multi-consumer load (phaseserv + oracle + dashboards).
candleEmitter.setMaxListeners(1000);

// Cache invalidation: drops every candles:latest:* key on each new candle.
// Extracted into a named function so closeAllListeners can re-attach it
// after a drain — without this, the first repair would silently break the
// cache invalidation that all REST consumers depend on.
function cacheInvalidationHandler() {
  return async () => {
    for (const tf of VALID_TFS) {
      // Common n values — consumers using SSE won't hit REST anyway
      for (const n of [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000]) {
        await redisDel(`candles:latest:${tf}:${n}`);
      }
    }
  };
}
candleEmitter.on("candle", cacheInvalidationHandler());

// candleEmitter.emit("candle", candleJson) — fired by collector after each write
// candleEmitter.emit("source_state", { source, state, previousState, timestamp }) — fired on source transition
// candleEmitter.emit("__close__", { reason }) — fired by closeAllListeners() to drain in-flight subscribers

/**
 * Drain all in-flight candle/source_state subscribers. Called by the repair
 * job start hook (Phase 5d): in-flight waitForFresh long-polls listen for
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
