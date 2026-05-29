/**
 * Public demo gate (Phase 10.2). Global middleware — a no-op outside demo mode.
 *
 * When IS_DEMO:
 *  - /v1/* (API-key consumer surface) is disabled → 403. Demo serves the page,
 *    not the programmatic API.
 *  - The allow-listed public read paths (isDemoReadPath) are served WITHOUT a
 *    session iff the request is same-origin AND carries a valid signed page
 *    token (D4). On success we set req.demoRead so sessionAuth.authenticate
 *    grants view-only access; on failure we 403 (rather than fall through to a
 *    confusing session 401, since demo has no login).
 *  - Everything else under /monitor falls through to normal session auth, which
 *    401s (login is hidden in the demo UI → effectively unreachable).
 */
import { Request, Response, NextFunction } from "express";
import {
  isDemoMode, isDemoReadPath, verifyDemoToken, demoTokenFromReq, isSameOrigin, chargeDemoToken,
} from "../lib/demoMode.js";

export async function demoGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  if (!(await isDemoMode())) return next();

  // API consumer surface is off in demo.
  if (req.path === "/v1" || req.path.startsWith("/v1/")) {
    return res.status(403).json({ error: "API disabled in demo mode" });
  }

  if (isDemoReadPath(req)) {
    const token = demoTokenFromReq(req);
    const originOk = isSameOrigin(req);
    const tokenOk = verifyDemoToken(token);
    if (!(originOk && tokenOk)) {
      return res.status(403).json({
        error: "Demo read requires a same-origin request with a valid page token",
      });
    }
    // Per-token request budget — a copied token can't be hammered forever.
    const charge = chargeDemoToken(token!);
    if (!charge.ok) {
      return res.status(429).json({ error: "Page token request budget exhausted — reload the page" });
    }
    req.demoRead = true;
    return next();
  }

  return next();
}
