import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { findApiKey, updateApiKeyNonce } from "../db/apiKeys";
import { recordError } from "../db/errors";

/**
 * API key auth middleware for /v1/* routes.
 *
 * Token = base64( apiKey + ':' + nonce + ':' + SHA256(secret+':'+nonce).slice(0,19) )
 */
export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "Authorization header required" });

  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return res.status(401).json({ error: "Invalid token format" });

    const [apiKey, nonceStr, chop] = parts;
    const nonce = BigInt(nonceStr);

    const row = await findApiKey(apiKey);
    if (!row || !row.enabled) return res.status(401).json({ error: "Invalid or disabled API key" });

    if (nonce <= row.nonce) return res.status(401).json({ error: "Nonce replay rejected" });

    const expected = crypto
      .createHash("sha256")
      .update(`${row.secret}:${nonceStr}`)
      .digest("hex")
      .slice(0, 19);

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(chop))) {
      return res.status(401).json({ error: "Invalid token" });
    }

    await updateApiKeyNonce(row.id, nonce);

    req.apiKeyId = row.id;
    req.apiKey = row.apiKey;
    return next();
  } catch (err) {
    await recordError("api", "apiKeyAuth", String(err));
    return res.status(401).json({ error: "Authorization failed" });
  }
}
