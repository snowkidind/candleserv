import { Router } from "express";
import { query } from "../db/pool.js";
import { countPendingGaps } from "../db/gaps.js";
import { getCollectionLatencyStats } from "../db/candles.js";
import { getRecentOutages } from "../db/serviceEvents.js";
import { getAllClients } from "../lib/subscriptions.js";
import { logError } from "../lib/log.js";

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    const [latestRes, pendingGaps, latency, recentOutages] = await Promise.all([
      query(`SELECT "timestamp" FROM candles_1m ORDER BY "timestamp" DESC LIMIT 1`),
      countPendingGaps(),
      getCollectionLatencyStats("BTC", 60),
      getRecentOutages(5).catch(() => []),
    ]);

    const latestCandle = latestRes.rows[0]?.timestamp ?? null;
    const uptimeSeconds = Math.floor(process.uptime());
    const activeSubscriptions = getAllClients().length;

    return res.json({
      status: "ok",
      uptime: uptimeSeconds,
      latestCandle,
      gapsPending: pendingGaps,
      activeSubscriptions,
      collectionLatency: latency,
      recentOutages,
    });
  } catch (err) {
    logError("[health] GET /health failed:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

export default router;
