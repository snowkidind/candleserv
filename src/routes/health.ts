import { Router } from "express";
import { query } from "../db/pool";
import { countPendingGaps } from "../db/gaps";
import { getCollectionLatencyStats } from "../db/candles";
import { getAllClients } from "../lib/subscriptions";

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    const [latestRes, pendingGaps, latency] = await Promise.all([
      query(`SELECT "timestamp" FROM candles_1m ORDER BY "timestamp" DESC LIMIT 1`),
      countPendingGaps(),
      getCollectionLatencyStats(60),
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
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

export default router;
