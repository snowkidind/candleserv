import express from "express";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log, logError } from "./lib/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import healthRouter from "./routes/health.js";
import setupRouter from "./routes/setup.js";
import v1CandlesRouter from "./routes/v1/candles.js";
import v1PremiumRouter from "./routes/v1/premium.js";
import v1PegRouter from "./routes/v1/peg.js";
import v1CurrenciesRouter from "./routes/v1/currencies.js";
import monitorAuthRouter from "./routes/monitor/auth.js";
import monitorErrorsRouter from "./routes/monitor/errors.js";
import monitorOperationalRouter from "./routes/monitor/operational.js";
import monitorStreamRouter from "./routes/monitor/stream.js";
import internalRouter from "./routes/internal.js";
import { repairLock } from "./middleware/repairLock.js";
import { demoGate } from "./middleware/demoGate.js";
import { demoRateLimit, demoPageRateLimit } from "./middleware/demoRateLimit.js";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { isDemoMode, mintDemoToken } from "./lib/demoMode.js";

export async function createApp(): Promise<express.Application> {
  const app = express();
  const demo = await isDemoMode();

  app.use(express.json());
  app.use(cookieParser());

  // Behind the demo droplet's reverse proxy, trust X-Forwarded-For so the IP
  // rate-limit (demoRateLimit) sees the real client IP, not the proxy.
  if (demo) {
    app.set("trust proxy", true);
    log("[app] IS_DEMO — public demo mode active");
  }

  // Read-only instance: block all mutations except auth endpoints
  if (process.env.READONLY_MODE === "true") {
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        return next();
      }
      if (req.path === "/monitor/login" || req.path === "/monitor/logout") {
        return next();
      }
      // Batch candle fetch uses POST for body-encoded request list but is
      // semantically a read — explicit whitelist so read-only replicas serve it.
      if (req.method === "POST" && req.path === "/v1/candles/multi") {
        return next();
      }
      return res.status(403).json({ error: "Read-only mode: write operations are disabled on this instance" });
    });
  }

  // Phase 5 repair-lock: 503 on candle-poll endpoints while a recompose/repair
  // job is in flight. Whitelists SSE, /health, repair job status/cancel, and
  // every other /monitor/* path. Mirrors the READONLY_MODE pattern above.
  app.use(repairLock);

  // Demo IP rate-limit (Phase 10.4) — no-op unless IS_DEMO && rateLimitEnabled.
  // Mounted right after repairLock so demo read floods are shed early.
  app.use(demoRateLimit);

  app.use((req, res, next) => {
    res.on("finish", () => log(`[access] ${req.method} ${req.path} ${res.statusCode}`));
    next();
  });

  // Unauthenticated
  app.use("/", healthRouter);

  // Setup wizard — only active when SETUP_COMPLETE is not true
  if (process.env.SETUP_COMPLETE !== "true") {
    app.use("/setup", setupRouter);

    // Block all other routes until setup is done
    app.use((_req, res) => {
      res.status(503).json({ error: "Setup required. Navigate to /setup to configure candleserv." });
    });

    return app;
  }

  // Setup wizard routes (still accessible post-install for reference, but install will error gracefully)
  app.use("/setup", setupRouter);

  // Demo gate (Phase 10.2) — no-op unless IS_DEMO. Disables /v1 and gates the
  // public monitor read paths on a same-origin signed page token. Must precede
  // the /v1 + monitor routers.
  app.use(demoGate);

  // API consumer routes — API key auth applied ONCE at the /v1 boundary. Each
  // domain router mounts at a DISJOINT /v1/<domain> sub-prefix so no router
  // falls through into a sibling's middleware. apiKeyAuth is stateful (advances
  // a single-use nonce); registering it per-router under a shared /v1 mount
  // double-ran it via Express fall-through → 401 Nonce replay. See plan D10.
  app.use("/v1", apiKeyAuth);
  app.use("/v1/candles", v1CandlesRouter);
  app.use("/v1/premium", v1PremiumRouter);
  app.use("/v1/peg", v1PegRouter);
  app.use("/v1/currencies", v1CurrenciesRouter);

  // Operator routes — localhost-only (cli/ctl.ts). No demo/session gating;
  // the router enforces a direct loopback connection itself.
  app.use("/internal", internalRouter);

  // Monitor routes — session cookie auth
  app.use("/monitor", monitorAuthRouter);
  app.use("/monitor", monitorErrorsRouter);
  app.use("/monitor", monitorOperationalRouter);
  app.use("/monitor", monitorStreamRouter);

  // Serve the canonical API docs (Postman collection + environment) so the
  // monitor's API tab can offer a download without duplicating the files into
  // the frontend bundle. docs/api sits at the repo root, one level above dist/
  // (and above src/ in dev). Public, non-secret — exempt from demo/session gates.
  app.use("/api-docs", express.static(path.join(__dirname, "..", "docs", "api")));

  // Serve frontend static files. In demo, index.html (the SPA entry + every
  // deep-link fallback) is served with a freshly-minted signed page token
  // injected as window.__DEMO__ (Phase 10.3); assets still come from static.
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  const indexHtmlPath = path.join(frontendDist, "index.html");
  const spaFallback = /^(?!\/v1|\/monitor|\/health|\/setup|\/internal).*/;

  if (demo) {
    // Rate-limit only the token-minting HTML serves (not static assets, which a
    // single page load pulls several of) to slow token harvesting.
    app.get("/", demoPageRateLimit, serveDemoIndex(indexHtmlPath));
    app.use(express.static(frontendDist));
    app.get(spaFallback, demoPageRateLimit, serveDemoIndex(indexHtmlPath));
  } else {
    app.use(express.static(frontendDist));
    app.get(spaFallback, (_req, res) => res.sendFile(indexHtmlPath));
  }

  return app;
}

function serveDemoIndex(indexHtmlPath: string) {
  return (_req: express.Request, res: express.Response): void => {
    try {
      // Read fresh each serve (tiny file) — NOT cached, so a frontend rebuild
      // doesn't leave us injecting into a stale index.html that points at
      // deleted asset hashes. Only the token varies per serve anyway.
      const raw = fs.readFileSync(indexHtmlPath, "utf8");
      const payload = JSON.stringify({ isDemo: true, token: mintDemoToken() });
      // Classic inline script → runs before the deferred module bundle, so
      // window.__DEMO__ is set before React boots. Injected at <head> open.
      const inject = `<head>\n    <script>window.__DEMO__=${payload};</script>`;
      if (!raw.includes("<head>")) {
        throw new Error("index.html missing <head> — cannot inject demo token");
      }
      const html = raw.replace("<head>", inject);
      res.type("html").send(html);
    } catch (err) {
      logError("[app] serveDemoIndex failed:", err);
      res.status(500).send("demo index unavailable");
    }
  };
}
