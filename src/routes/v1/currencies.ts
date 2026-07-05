import { Router } from "express";
import { getEnabledCurrencyInfo } from "../../db/currencies.js";
import { logError } from "../../lib/log.js";

/**
 * GET /v1/currencies — the enabled currency set (code + inceptionTs floor).
 *
 * A read-only sibling of the candles/peg routers over data candleserv already
 * owns (the `currencies` control-plane table). Exposes the enabled set on the
 * API-key /v1 surface so a downstream consumer (phaseserv) can discover which
 * currencies to compute without cookie/monitor auth. Enabled currencies only,
 * BTC first; SELECT-only, no persistence, no new tracking.
 *
 * Mounted at /v1/currencies; the route below is relative (`/`). Auth is applied
 * once at the /v1 boundary (app.use("/v1", apiKeyAuth)) — this router registers
 * NO auth of its own.
 *
 * Response: { currencies: [ { code, inceptionTs: <iso|null> }, ... ] }
 * inceptionTs is the B3 temporal floor (null → consumers COALESCE to now-90d).
 */
const router = Router();

router.get("/", async (_req, res) => {
  try {
    const rows = await getEnabledCurrencyInfo();
    return res.json({
      currencies: rows.map((r) => ({
        code: r.code,
        inceptionTs: r.inceptionTs ? r.inceptionTs.toISOString() : null,
      })),
    });
  } catch (err) {
    logError("[v1/currencies] GET /currencies failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
