/**
 * Public demo gate. Global middleware — a no-op outside demo mode.
 *
 * In demo the admin view is a PUBLIC READ-ONLY MIRROR:
 *  - /v1/* (API-key consumer surface) → 403. Demo serves the page, not the API.
 *  - Every /monitor GET is served WITHOUT a session iff same-origin + a valid
 *    signed page token (sets req.demoRead → sessionAuth grants view-only),
 *    EXCEPT the secret-bearing reads (config / api-key material) which 403.
 *  - Every /monitor non-GET (mutation) → 403. Combined with the UI's disabled
 *    controls, this is the "see everything, change nothing" demo posture.
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

  if (req.path.startsWith("/monitor/")) {
    // All mutations are denied — the admin controls are inert in demo.
    if (req.method !== "GET") {
      return res.status(403).json({ error: "Read-only demo: this action is disabled" });
    }
    // A GET that's NOT an allowed read = a secret-bearing path (config / keys).
    if (!isDemoReadPath(req)) {
      return res.status(403).json({ error: "Not available in demo" });
    }
    const token = demoTokenFromReq(req);
    if (!(isSameOrigin(req) && verifyDemoToken(token))) {
      return res.status(403).json({ error: "Demo read requires a same-origin request with a valid page token" });
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
