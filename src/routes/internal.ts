/**
 * Localhost-only operator endpoints (consumed by scripts/ctl.ts). NOT
 * authenticated — instead locked to a DIRECT loopback connection:
 *   - req.socket.remoteAddress must be a loopback address (the raw socket, NOT
 *     req.ip, which trust-proxy could spoof), AND
 *   - no X-Forwarded-For header (a same-host reverse proxy would otherwise relay
 *     as loopback — reject anything that took a proxy hop).
 * The operator's reverse proxy must never forward /internal/*; this is the
 * in-app backstop. The same data/actions are exposed under /monitor/* (session +
 * CAN_MODIFY auth) for the admin panel — both share lib/runtimeStats helpers.
 */
import { Router, Request, Response, NextFunction } from "express";
import { buildRuntimeSnapshot, flushCandleCache } from "../lib/runtimeStats.js";
import { apiStatsSnapshot } from "../lib/apiCounter.js";
import { deleteAllSessions } from "../db/sessions.js";
import { log, logError } from "../lib/log.js";

const router = Router();

function isLoopback(addr?: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function requireLoopback(req: Request, res: Response, next: NextFunction): void | Response {
  if (!isLoopback(req.socket.remoteAddress) || req.headers["x-forwarded-for"]) {
    return res.status(403).json({ error: "internal endpoint: direct localhost only" });
  }
  return next();
}

router.use(requireLoopback);

/** GET /internal/runtime — in-memory + process stats the CLI prints. */
router.get("/runtime", async (_req, res) => {
  try {
    return res.json(await buildRuntimeSnapshot());
  } catch (err) {
    logError("[internal] GET /runtime failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /internal/api-stats — rolling 1h/4h/8h/24h outgoing-request counters. */
router.get("/api-stats", (_req, res) => {
  return res.json(apiStatsSnapshot());
});

/** POST /internal/cache/flush — drop the candle redis cache (candles:* keys). */
router.post("/cache/flush", async (_req, res) => {
  try {
    const r = await flushCandleCache();
    return res.json({ ok: true, ...r });
  } catch (err) {
    logError("[internal] POST /cache/flush failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/** POST /internal/sessions/flush — delete ALL sessions (forces re-login everywhere). */
router.post("/sessions/flush", async (_req, res) => {
  try {
    const removed = await deleteAllSessions();
    log(`[internal] sessions flush — removed ${removed} session rows`);
    return res.json({ ok: true, removed });
  } catch (err) {
    logError("[internal] POST /sessions/flush failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
