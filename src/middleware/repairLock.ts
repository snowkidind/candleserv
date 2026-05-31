/**
 * Repair-lock middleware — Phase 5d of the exchange-expansion plan.
 *
 * While a repair job is in progress (`isRepairInProgress()`), candle-read
 * REST endpoints return HTTP 503. Everything else stays available — operator
 * can still inspect formula state, sources/status, gaps, errors, etc., and
 * the running progress panel keeps polling the repair job endpoints.
 *
 * Long-poll waitForFresh waiters that were already past this middleware
 * before the job started are drained via emitter.closeAllListeners() at
 * job start; see startRepairJob.
 *
 * Pattern mirrors the existing READONLY_MODE middleware in app.ts:23-38.
 */
import type { Request, Response, NextFunction } from "express";
import { isRepairInProgress } from "../lib/repairJobs.js";

/**
 * Exact (method, path) pairs that the lock should 503. Anything not on this
 * list passes through unchanged.
 *
 * Includes the candle-data endpoints — both v1 (consumer API) and monitor
 * (operator UI). The waitForFresh long-poll lives on GET /v1/candles; new
 * requests get 503'd here, in-flight ones drain via closeAllListeners.
 *
 * SSE endpoints (/v1/candles/stream, /monitor/candles/stream) are NOT
 * blocked — live collector keeps emitting and consumers stay connected
 * (they're dropped once by closeAllListeners at repair start and immediately
 * reconnect; sub-second gap, no data loss).
 *
 * /monitor/repair/jobs/* and all other /monitor/* paths are NOT blocked.
 */
const BLOCK_LIST: Array<{ method: string; path: string }> = [
  { method: "GET",  path: "/v1/candles"           },
  { method: "GET",  path: "/v1/candles/latest"    },
  { method: "POST", path: "/v1/candles/multi"     },
  { method: "GET",  path: "/v1/premium"           },
  { method: "GET",  path: "/v1/premium/venues"    },
  { method: "GET",  path: "/monitor/candles"      },
  { method: "GET",  path: "/monitor/candles/latest" },
];

export function repairLock(req: Request, res: Response, next: NextFunction): void {
  if (!isRepairInProgress()) return next();
  const blocked = BLOCK_LIST.some(
    (e) => e.method === req.method && e.path === req.path,
  );
  if (!blocked) return next();
  res.status(503).json({
    error: "repair in progress",
    retryAfter: "candle reads are paused while a recompose/repair job runs",
  });
}
