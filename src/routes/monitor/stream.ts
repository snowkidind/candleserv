import { Router } from "express";
import { trackSession, authenticate, requirePerm } from "../../middleware/sessionAuth";
import { getCandles, VALID_TFS } from "../../db/candles";
import { candleEmitter } from "../../lib/emitter";

const router = Router();
const guard = [trackSession, authenticate, requirePerm("CAN_VIEW_CANDLESERV")];

/**
 * GET /monitor/candles/stream?tf=<tf>
 * Monitor SSE — session cookie, all TFs, single candle per event.
 */
router.get("/candles/stream", ...guard, async (req, res) => {
  const tf = (req.query.tf as string) || "1m";
  const n  = Math.min(parseInt(req.query.n as string, 10) || 200, 1000);
  if (!VALID_TFS.includes(tf)) {
    return res.status(400).json({ error: "Invalid tf" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Push full N-candle snapshot — used on connect and on every new candle
  const pushSnapshot = async () => {
    try {
      const candles = await getCandles({ tf, endingAt: new Date(), limit: n });
      console.log(`[stream] tf=${tf} n=${n} getCandles returned ${candles.length}`);
      res.write(`event: candles\ndata: ${JSON.stringify(candles)}\n\n`);
    } catch (err) {
      console.error(`[stream] getCandles error:`, err);
    }
  };

  await pushSnapshot();

  const onCandle = async () => {
    await pushSnapshot();
  };

  const onSourceState = (data: unknown) => {
    res.write(`event: source_state\ndata: ${JSON.stringify(data)}\n\n`);
  };

  candleEmitter.on("candle", onCandle);
  candleEmitter.on("source_state", onSourceState);

  const keepalive = setInterval(() => res.write(": ping\n\n"), 30000);

  req.on("close", () => {
    clearInterval(keepalive);
    candleEmitter.off("candle", onCandle);
    candleEmitter.off("source_state", onSourceState);
  });
});

export default router;
