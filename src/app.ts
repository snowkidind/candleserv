import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { log } from "./lib/log.js";

import healthRouter from "./routes/health.js";
import setupRouter from "./routes/setup.js";
import v1CandlesRouter from "./routes/v1/candles.js";
import monitorAuthRouter from "./routes/monitor/auth.js";
import monitorErrorsRouter from "./routes/monitor/errors.js";
import monitorOperationalRouter from "./routes/monitor/operational.js";
import monitorStreamRouter from "./routes/monitor/stream.js";

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  // Read-only instance: block all mutations except auth endpoints
  if (process.env.READONLY_MODE === "true") {
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        return next();
      }
      if (req.path === "/monitor/login" || req.path === "/monitor/logout") {
        return next();
      }
      return res.status(403).json({ error: "Read-only mode: write operations are disabled on this instance" });
    });
  }

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

  // API consumer routes — API key auth
  app.use("/v1", v1CandlesRouter);

  // Monitor routes — session cookie auth
  app.use("/monitor", monitorAuthRouter);
  app.use("/monitor", monitorErrorsRouter);
  app.use("/monitor", monitorOperationalRouter);
  app.use("/monitor", monitorStreamRouter);

  // Serve frontend static files for all other monitor routes
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));
  app.get(/^(?!\/v1|\/monitor|\/health|\/setup).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  return app;
}
