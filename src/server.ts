import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";
import { startCollector } from "./lib/collector";
import { runBackfill } from "./lib/healer";
import { startGapDetector } from "./lib/gapDetector";
import { pruneOldSessions } from "./db/sessions";
import { pruneSourceCandles } from "./db/candles";
import { initRedis } from "./lib/redis";
import { log, logError } from "./lib/log";

const PORT = parseInt(process.env.PORT ?? "3007", 10);

async function main(): Promise<void> {
  const app = createApp();

  app.listen(PORT, () => {
    log(`[candleserv] listening on port ${PORT}`);
  });

  if (process.env.SETUP_COMPLETE !== "true") {
    log("[candleserv] setup not complete — waiting for setup wizard");
    return;
  }

  // Connect to Redis (optional — logs and continues if unavailable)
  await initRedis();

  // Start live collection
  startCollector();

  // Background backfill (non-blocking — runs concurrently with collector)
  runBackfill().catch((err) => logError("[server] backfill error:", err));

  // Gap detection: startup scan + hourly
  startGapDetector().catch((err) => logError("[server] gap detector error:", err));

  // Daily maintenance: prune sessions + source candles
  setInterval(async () => {
    try {
      await pruneOldSessions();
      await pruneSourceCandles();
      log("[server] daily maintenance complete");
    } catch (err) {
      logError("[server] maintenance error:", err);
    }
  }, 24 * 60 * 60 * 1000);
}

main().catch((err) => {
  logError("[server] fatal startup error:", err);
  process.exit(1);
});
