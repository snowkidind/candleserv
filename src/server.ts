import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";
import { startCollector } from "./lib/collector";
import { runBackfill } from "./lib/healer";
import { startGapDetector } from "./lib/gapDetector";
import { pruneOldSessions } from "./db/sessions";
import { pruneSourceCandles } from "./db/candles";
import { initRedis } from "./lib/redis";
import { createSchema } from "./db/schema";
import { getSetting } from "./db/appSettings";
import { recordOutage } from "./db/serviceEvents";
import { log, logError } from "./lib/log";

const PORT = parseInt(process.env.PORT ?? "3007", 10);

async function detectAndRecordOutage(): Promise<void> {
  const lastHeartbeatStr = await getSetting("lastHeartbeat");
  if (!lastHeartbeatStr) {
    log("[server] no lastHeartbeat — first run, skipping outage check");
    return;
  }
  const lastHeartbeat = new Date(lastHeartbeatStr);
  const now = new Date();
  const deltaMinutes = Math.floor((now.getTime() - lastHeartbeat.getTime()) / 60000);
  if (deltaMinutes < 2) {
    log(`[server] clean restart — heartbeat gap ${deltaMinutes} min`);
    return;
  }
  log(`[server] outage detected: down ~${deltaMinutes} minutes (last heartbeat: ${lastHeartbeat.toISOString()})`);
  await recordOutage(lastHeartbeat, now, deltaMinutes);
}

async function main(): Promise<void> {
  const app = createApp();

  app.listen(PORT, () => {
    log(`[candleserv] listening on port ${PORT}`);
  });

  if (process.env.SETUP_COMPLETE !== "true") {
    log("[candleserv] setup not complete — waiting for setup wizard");
    return;
  }

  // Apply any schema changes (idempotent — CREATE TABLE IF NOT EXISTS)
  await createSchema();

  // Detect power failures / unplanned restarts via heartbeat gap
  await detectAndRecordOutage();

  // Connect to Redis (optional — logs and continues if unavailable)
  await initRedis();

  if (process.env.READONLY_MODE === "true") {
    log("[server] READONLY_MODE — collector, healer, gap detector, and maintenance disabled");
  } else {
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
}

main().catch((err) => {
  logError("[server] fatal startup error:", err);
  process.exit(1);
});
