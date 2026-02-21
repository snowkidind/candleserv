import { Router } from "express";
import { trackSession, authenticate, requirePerm } from "../../middleware/sessionAuth";
import { getRecentErrors } from "../../db/errors";

const router = Router();
const guard = [trackSession, authenticate, requirePerm("CAN_VIEW_CANDLESERV")];

router.get("/errors", ...guard, async (req, res) => {
  const { minutes, service, limit } = req.query as Record<string, string>;
  try {
    const errors = await getRecentErrors({
      minutes: minutes ? parseInt(minutes, 10) : 60,
      service: service || undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 1000) : 200,
    });
    return res.json({ errors });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
