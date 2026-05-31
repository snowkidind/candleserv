/**
 * Rate-limit for the /v1/premium consumer surface. Reuses the demo read
 * limiter's mechanism (src/middleware/demoRateLimit.ts → makeIpLimiter): a
 * per-key sliding 60s window with threshold = app_setting `rateLimitPerMinute`
 * (default 120), 429 + `Retry-After: 60` on breach — the same limits the public
 * demo applies to its reads.
 *
 * Differences from demoRateLimit, both deliberate:
 *   - Always enforced (not gated on IS_DEMO / `rateLimitEnabled`). /v1 is
 *     disabled wholesale in demo, so a demo gate would make this never fire;
 *     `rateLimitEnabled` is the demo's own kill-switch, not a knob for the
 *     authed product API. `rateLimitPerMinute = 0` still disables it.
 *   - Keyed by API key id (this runs after apiKeyAuth), falling back to IP.
 *     Authed traffic is the thing being limited, so the key is the right bucket
 *     and it doesn't depend on `trust proxy` being set outside demo.
 *
 * Own limiter instance → its own bucket, never shares with demo read traffic.
 */
import { Request, Response, NextFunction } from "express";
import { makeIpLimiter } from "./demoRateLimit.js";
import { getSettingInt } from "../db/appSettings.js";

const limiter = makeIpLimiter("premium");

export async function premiumRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const perMinute = await getSettingInt("rateLimitPerMinute", 120);
  if (perMinute <= 0) return next();

  const key = req.apiKeyId != null ? `k:${req.apiKeyId}` : `ip:${req.ip ?? "unknown"}`;
  if (limiter.exceeded(key, Date.now(), perMinute)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Rate limit exceeded — slow down" });
  }
  return next();
}
