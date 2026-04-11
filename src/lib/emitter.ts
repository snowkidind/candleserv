import { EventEmitter } from "events";
import { redisDel } from "./redis.js";
import { VALID_TFS } from "../db/candles.js";

/**
 * Internal event bus. The live collector emits here after each successful
 * composite write. SSE handlers subscribe to fan out to connected clients.
 */
class CandleEmitter extends EventEmitter {}

export const candleEmitter = new CandleEmitter();

// Invalidate all candles:latest:* cache keys on every new candle
candleEmitter.on("candle", async () => {
  for (const tf of VALID_TFS) {
    // Invalidate common n values — consumers using SSE won't hit REST anyway
    for (const n of [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      await redisDel(`candles:latest:${tf}:${n}`);
    }
  }
});

// candleEmitter.emit("candle", candleJson) — fired by collector after each write
// candleEmitter.emit("source_state", { source, state, previousState, timestamp }) — fired on source transition
