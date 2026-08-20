/**
 * Repair-lock middleware — per-currency single-flight.
 *
 * A candle-read endpoint returns HTTP 503 ONLY if the currency it reads is
 * mid-repair (`isCurrencyRepairing`). A TON repair therefore does not 503 a BTC
 * read. A stable-rate repair that asked to suspend globally
 * (`isGlobalRepairSuspend`) 503s every candle read regardless of currency, since
 * pegs are shared across currencies. Everything off the block list stays
 * available — operator can still inspect formula state, sources/status, gaps,
 * errors, and the running progress panel keeps polling the repair job endpoints.
 *
 * Long-poll waitForFresh waiters that were already past this middleware before
 * the job started are drained via emitter.closeAllListeners() at job start; see
 * startRepairJob. Pattern mirrors the READONLY_MODE middleware in app.ts.
 */
import type { Request, Response, NextFunction } from "express";
import { isCurrencyRepairing, isGlobalRepairSuspend } from "../lib/repairJobs.js";

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

function send503(res: Response): void {
  res.status(503).json({
    error: "repair in progress",
    retryAfter: "candle reads are paused while a recompose/repair job runs",
  });
}

// Normalize a currency value the way the candle routes do: trim/upper, default BTC.
function normCurrency(raw: unknown): string {
  return (typeof raw === "string" && raw.trim() ? raw.trim() : "BTC").toUpperCase();
}

/**
 * The currency(ies) a candle-read request touches. GET routes carry it in
 * `req.query.currency` (default BTC). POST /v1/candles/multi carries a per-entry
 * currency array — any entry mid-repair 503s the whole request (no partial
 * results). Body is available here because express.json() runs before this
 * middleware (app.ts).
 */
function requestCurrencies(req: Request): string[] {
  if (req.method === "POST" && req.path === "/v1/candles/multi") {
    const reqs = (req.body && Array.isArray(req.body.requests)) ? req.body.requests as Array<{ currency?: unknown }> : [];
    if (reqs.length === 0) return ["BTC"];
    return reqs.map((r) => normCurrency(r?.currency));
  }
  return [normCurrency(req.query?.currency)];
}

export function repairLock(req: Request, res: Response, next: NextFunction): void {
  const blocked = BLOCK_LIST.some(
    (e) => e.method === req.method && e.path === req.path,
  );
  if (!blocked) return next();

  // A global-suspend repair (shared pegs) 503s every candle read regardless of currency.
  if (isGlobalRepairSuspend()) return send503(res);

  // Otherwise 503 only if THIS request's currency(ies) are mid-repair.
  if (requestCurrencies(req).some((c) => isCurrencyRepairing(c))) return send503(res);
  return next();
}
