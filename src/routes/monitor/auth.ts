import { Router } from "express";
import { trackSession } from "../../middleware/sessionAuth";
import { findUserByEmail, verifyPassword, touchLastLogin, touchLastLoginFail } from "../../db/users";
import { assignUserToSession, clearUserFromSession } from "../../db/sessions";
import { log } from "../../lib/log";

const router = Router();

router.post("/login", trackSession, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      log(`[auth] login failed — unknown email: ${email}`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await touchLastLoginFail(user.id);
      log(`[auth] login failed — wrong password for: ${email}`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await assignUserToSession(req.sessionId!, user.id);
    await touchLastLogin(user.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/logout", trackSession, async (req, res) => {
  if (req.sessionId) await clearUserFromSession(req.sessionId);
  res.clearCookie("session");
  return res.json({ ok: true });
});

export default router;
