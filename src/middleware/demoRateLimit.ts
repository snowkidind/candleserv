/**
 * Demo IP rate-limits (Phase 10.4). No-ops unless IS_DEMO AND rateLimitEnabled.
 * Sliding 60s window per client IP.
 *
 *  - `demoRateLimit`     → the public read paths (mounted after repairLock).
 *                          Threshold = app_setting `rateLimitPerMinute`.
 *  - `demoPageRateLimit` → the index.html serve (`GET /` + SPA deep-links),
 *                          which mints a fresh page token each hit. Throttling it
 *                          slows token *harvesting*. Threshold = `PAGE_MINT_PER_MINUTE`
 *                          const (page loads are rare; no per-deploy tuning need).
 *
 * Named demoRateLimit to avoid collision with lib/rateLimit.ts, the unrelated
 * OUTBOUND per-venue exchange-API gate.
 *
 * In-memory (single droplet, single process). Behind nginx the real client IP
 * needs `trust proxy` set (app.ts does this in demo) so req.ip isn't the proxy.
 */
import { Request, Response, NextFunction } from "express";
import { isDemoMode, isDemoReadPath } from "../lib/demoMode.js";
import { getSettingBool, getSettingInt } from "../db/appSettings.js";
import { logError } from "../lib/log.js";

const WINDOW_MS = 60_000;
// Hard ceiling on distinct tracked IPs per limiter — a distributed flood (millions
// of unique source IPs) can't grow a map without bound. ~100k buckets ≈ low tens
// of MB; a real demo sees far fewer active IPs per minute. Volumetric DDoS is an
// edge/CDN concern, not something this in-process Map defends — this cap just
// prevents OOM.
const MAX_TRACKED_IPS = 100_000;
// Page-token mints per IP per minute. A human loads/reloads the page a handful of
// times; a harvester wants far more. Generous for the former, a brake on the latter.
const PAGE_MINT_PER_MINUTE = 30;

/**
 * A self-contained per-IP sliding-window limiter over its own Map. `exceeded(ip,
 * now, perMinute)` returns true if the request should be rejected (over the
 * window threshold OR the map is at capacity) — otherwise it records the hit and
 * returns false. One instance per surface so read and page traffic don't share a
 * bucket.
 */
function makeIpLimiter(label: string) {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  const prune = (now: number): void => {
    for (const [ip, ts] of hits) {
      if (!ts.length || ts[ts.length - 1] <= now - WINDOW_MS) hits.delete(ip);
    }
  };

  const exceeded = (ip: string, now: number, perMinute: number): boolean => {
    if (now - lastSweep >= WINDOW_MS) { lastSweep = now; prune(now); }

    const windowStart = now - WINDOW_MS;
    const existing = hits.get(ip);
    const recent = (existing ?? []).filter((t) => t > windowStart);

    if (recent.length >= perMinute) return true;

    // New IP under a distinct-IP flood: enforce the size cap before allocating.
    if (!existing && hits.size >= MAX_TRACKED_IPS) {
      prune(now);
      if (hits.size >= MAX_TRACKED_IPS) {
        logError(
          `[demoRateLimit] ${label} IP map at capacity (${MAX_TRACKED_IPS}) — shedding new IPs. ` +
          `Distributed flood; front the demo with an edge rate-limit (nginx/CDN).`,
        );
        return true;
      }
    }

    recent.push(now);
    hits.set(ip, recent);
    return false;
  };

  return { exceeded, size: () => hits.size };
}

const readLimiter = makeIpLimiter("read");
const pageLimiter = makeIpLimiter("page");

/** Tracked-IP counts for both limiter maps (ops visibility — see cli/ctl.ts). */
export function demoRateLimitStats(): { readIps: number; pageIps: number } {
  return { readIps: readLimiter.size(), pageIps: pageLimiter.size() };
}

export async function demoRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  if (!(await isDemoMode())) return next();
  if (!isDemoReadPath(req)) return next();
  if (!(await getSettingBool("rateLimitEnabled", false))) return next();

  const perMinute = await getSettingInt("rateLimitPerMinute", 120);
  if (perMinute <= 0) return next();

  if (readLimiter.exceeded(req.ip ?? "unknown", Date.now(), perMinute)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Rate limit exceeded — slow down" });
  }
  return next();
}

export async function demoPageRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  if (!(await isDemoMode())) return next();
  if (!(await getSettingBool("rateLimitEnabled", false))) return next();

  if (pageLimiter.exceeded(req.ip ?? "unknown", Date.now(), PAGE_MINT_PER_MINUTE)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).type("text/plain").send("Too many requests — slow down");
  }
  return next();
}
