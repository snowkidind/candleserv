import { Request, Response, NextFunction } from "express";
import { getOrCreateSession } from "../db/sessions.js";
import { findUserById } from "../db/users.js";
import { getPermissionsForUser } from "../db/permissions.js";
import { logError } from "../lib/log.js";

const COOKIE_NAME = "candleserv_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Reads or creates a session cookie on every request.
 * Sets req.sessionId, req.userId, req.isAuthenticated.
 */
export async function trackSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const cookies = req.cookies ?? {};
    const existing = cookies[COOKIE_NAME] as string | undefined;
    const { sessionId, userId } = await getOrCreateSession(existing);

    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      maxAge: COOKIE_MAX_AGE,
    });

    req.sessionId = sessionId;
    req.userId = userId ?? undefined;
    req.isAuthenticated = userId != null;
    return next();
  } catch (err) {
    logError("[sessionAuth] trackSession:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Requires an authenticated session (userId set). 401 otherwise.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  // Public demo read: demoGate already validated the same-origin
  // signed page token for an allow-listed read path. Grant view-only access
  // without a session — modify routes require CAN_MODIFY and so stay blocked.
  if (req.demoRead) {
    req.perms = { CAN_VIEW_CANDLESERV: true };
    return next();
  }

  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const user = await findUserById(req.userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    req.perms = await getPermissionsForUser(req.userId);
    return next();
  } catch (err) {
    logError("[sessionAuth] authenticate:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Requires a specific permission. Call after authenticate.
 */
export function requirePerm(perm: string) {
  return function (req: Request, res: Response, next: NextFunction): void | Response {
    if (!req.perms?.[perm]) {
      return res.status(403).json({ error: `Forbidden: ${perm} required` });
    }
    return next();
  };
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void | Response {
  if (!req.perms?.["SUPERADMIN"]) {
    return res.status(403).json({ error: "Forbidden: superadmin required" });
  }
  return next();
}
