/**
 * candleserv operator CLI — thin client over the localhost-only /internal API
 * (src/routes/internal.ts). The stats it shows live in the SERVER process's
 * memory, so this talks to the running server over loopback rather than reading
 * the DB directly. Must be run on the same host as the server.
 *
 * Usage:
 *   npx tsx cli/ctl.ts stats            # in-memory + process stats
 *   npx tsx cli/ctl.ts cache:flush      # drop the candle redis cache (candles:*)
 *   npx tsx cli/ctl.ts sessions:flush   # delete ALL sessions (forces re-login)
 */
process.env.TZ = "UTC";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ctl.ts lives in cli/, but the server's .env (PORT etc.) is in the repo root.
// Resolve relative to this file — not cwd — so it works no matter where it's run from.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const PORT = parseInt(process.env.PORT ?? "3007", 10);
const BASE = `http://127.0.0.1:${PORT}`;

const USAGE = `usage: npx tsx cli/ctl.ts <command>

commands:
  stats              in-memory + process stats from the running server
  api [1h|4h|8h|24h] outgoing exchange-request counters (rolling windows)
  horizon [days]     view (no arg) or set the repair-reach horizon in days
  cache:flush        drop the candle redis cache (candles:* keys)
  sessions:flush     delete ALL sessions (forces every browser to re-login)`;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

async function call(path: string, method: "GET" | "POST" = "GET"): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method });
  } catch (err) {
    throw new Error(`cannot reach server at ${BASE} — is it running on PORT=${PORT}? (${String(err)})`);
  }
  // A non-JSON 200 means the request fell through to the SPA fallback (HTML) —
  // i.e. this server build predates /internal. Fail loud rather than parse NaN.
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) {
    throw new Error(
      `${path} returned ${res.status} ${ctype || "no content-type"}, not JSON — ` +
      `the running server is missing the /internal API. Rebuild + restart it.`,
    );
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  switch (cmd) {
    case "stats": {
      const r = await call("/internal/runtime");
      console.log(`candleserv @ ${BASE}`);
      console.log(`  uptime          ${fmtUptime(r.uptimeSeconds)}`);
      console.log(`  demo mode       ${r.demoMode}`);
      console.log(`  memory          rss ${mb(r.memory.rss)} | heap ${mb(r.memory.heapUsed)}/${mb(r.memory.heapTotal)} | external ${mb(r.memory.external)}`);
      console.log(`  demo tokens     ${r.demo.tokenBudgetEntries}`);
      console.log(`  rate-limit ips  read ${r.demo.readRateLimitIps} | page ${r.demo.pageRateLimitIps}`);
      console.log(`  sse clients     ${r.live.sseClients}`);
      console.log(`  lastClose map   ${r.live.lastCloseEntries}`);
      console.log(`  backfilling     ${r.live.backfillRunning}`);
      console.log(`  sessions        ${r.sessions.total} (${r.sessions.authenticated} authed)`);
      console.log(`  redis           ${r.redis.available ? "connected" : "unavailable"}`);
      break;
    }
    case "api": {
      const r = await call("/internal/api-stats");
      const valid = ["1h", "4h", "8h", "24h"];
      const win = process.argv[3];
      if (win && !valid.includes(win)) {
        console.error(`window must be one of: ${valid.join(", ")}`);
        process.exit(1);
      }
      if (win) {
        const w = r.windows[win];
        console.log(`${win} outgoing requests — ${w.total} total`);
        console.log(`  ${"count".padStart(7)}  ${"currency".padEnd(8)} ${"source".padEnd(9)} type`);
        for (const row of w.rows as any[]) {
          console.log(`  ${String(row.count).padStart(7)}  ${row.currency.padEnd(8)} ${row.source.padEnd(9)} ${row.type}`);
        }
        if (!w.rows.length) console.log("  (none)");
      } else {
        console.log(`outgoing API requests (rolling) @ ${r.generatedAt}`);
        for (const k of valid) {
          const w = r.windows[k];
          const types = Object.entries(w.byType).sort((a: any, b: any) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(" ");
          console.log(`  ${k.padEnd(4)} ${String(w.total).padStart(7)}   ${types || "-"}`);
        }
        const cur = Object.entries(r.windows["24h"].byCurrency).sort((a: any, b: any) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(" ");
        console.log(`  by currency (24h): ${cur || "-"}`);
        console.log(`  (run 'api <window>' for the full per-source breakdown)`);
      }
      break;
    }
    case "horizon": {
      const arg = process.argv[3];
      if (arg === undefined) {
        const r = await call("/internal/repair-horizon");
        console.log(`repair horizon: ${r.days} days${r.isDefault ? " (default)" : ""}`);
      } else {
        const days = parseInt(arg, 10);
        if (!Number.isInteger(days) || days <= 0) {
          console.error("days must be a positive integer");
          process.exit(1);
        }
        const r = await call(`/internal/repair-horizon?days=${days}`, "POST");
        console.log(`repair horizon: ${r.previous} → ${r.days} days`);
        if (days > r.previous) {
          console.log(`  note: source archive still prunes at the default; repairs beyond it re-fetch from`);
          console.log(`        the exchange. Confirm per-venue reach with: npx tsx cli/probe-earliest.ts`);
        }
      }
      break;
    }
    case "cache:flush": {
      const r = await call("/internal/cache/flush", "POST");
      console.log(`cache flushed: ${r.flushed} key(s)${r.note ? ` (${r.note})` : ""}`);
      break;
    }
    case "sessions:flush": {
      const r = await call("/internal/sessions/flush", "POST");
      console.log(`sessions flushed: ${r.removed} row(s) — all browsers must re-login`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ctl error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
