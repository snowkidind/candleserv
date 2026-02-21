/**
 * Candleserv test caller
 *
 * Usage:
 *   CANDLESERV_URL=http://localhost:3007 \
 *   CANDLESERV_API_KEY=<your key> \
 *   CANDLESERV_SECRET=<your secret> \
 *   npx tsx scripts/testCaller.ts
 */
import crypto from "crypto";

const URL    = process.env.CANDLESERV_URL    ?? "http://localhost:3007";
const KEY    = process.env.CANDLESERV_API_KEY ?? "";
const SECRET = process.env.CANDLESERV_SECRET  ?? "";

if (!KEY || !SECRET) {
  console.error("\n✗ CANDLESERV_API_KEY and CANDLESERV_SECRET must be set\n");
  process.exit(1);
}

function makeToken(): string {
  const nonce = Date.now();
  const enc   = crypto.createHash("sha256").update(`${SECRET}:${nonce}`).digest("hex");
  const chop  = enc.slice(0, 19);
  return Buffer.from(`${KEY}:${nonce}:${chop}`).toString("base64");
}

async function get(path: string, auth = true): Promise<unknown> {
  const headers: Record<string, string> = auth ? { Authorization: makeToken() } : {};
  const res = await fetch(`${URL}${path}`, { headers });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function main(): Promise<void> {
  console.log(`\nCandleserv test caller → ${URL}\n`);

  const health = await get("/health", false) as Record<string, unknown>;
  console.log("GET /health");
  console.log(`  status=${health.status} uptime=${health.uptime}s latestCandle=${health.latestCandle} gapsPending=${health.gapsPending}\n`);

  const m1 = await get("/v1/candles/latest?tf=1m&n=5") as { candles: Record<string, unknown>[] };
  console.log(`GET /v1/candles/latest?tf=1m&n=5`);
  console.log(`  → ${m1.candles.length} candles, latest close: ${m1.candles.at(-1)?.close}\n`);

  const m15 = await get("/v1/candles/latest?tf=15m&n=3") as { candles: Record<string, unknown>[] };
  console.log(`GET /v1/candles/latest?tf=15m&n=3`);
  console.log(`  → ${m15.candles.length} candles, latest close: ${m15.candles.at(-1)?.close}\n`);

  const m4h = await get("/v1/candles/latest?tf=4h&n=2") as { candles: Record<string, unknown>[] };
  console.log(`GET /v1/candles/latest?tf=4h&n=2`);
  console.log(`  → ${m4h.candles.length} candles, confidence: ${m4h.candles.at(-1)?.confidence}\n`);

  const sub = await get("/v1/candles/subscriptions") as Record<string, unknown>;
  console.log(`GET /v1/candles/subscriptions`);
  console.log(`  → active=${sub.active}\n`);

  console.log("✓ All requests succeeded\n");
}

main().catch((err: Error) => {
  console.error("\n✗ FAILED:", err.message, "\n");
  process.exit(1);
});
