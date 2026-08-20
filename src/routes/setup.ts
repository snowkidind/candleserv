import { Router } from "express";
import fs from "fs";
import path from "path";

// Resolve from project root so it works in both ts-node (src/) and compiled (dist/)
const WIZARD_HTML = path.join(process.cwd(), "src", "routes", "setup.html");
import crypto from "crypto";
import { Pool } from "pg";
import { createSchema, seedSettings } from "../db/schema.js";
import { createUser } from "../db/users.js";
import { grantPermission, PERM_SUPERADMIN } from "../db/permissions.js";
import { insertStreamEvent } from "../db/streamEvents.js";
import { setSetting } from "../db/appSettings.js";
import { log, logError } from "../lib/log.js";

const router = Router();

/** GET /setup — serve the wizard HTML */
router.get("/", (_req, res) => {
  res.sendFile(WIZARD_HTML);
});

/** POST /setup/test-db — test a postgres connection before committing */
router.post("/test-db", async (req, res) => {
  const { host, port, database, user, password } = req.body as Record<string, string>;
  const pool = new Pool({ host, port: parseInt(port, 10) || 5432, database, user, password });
  try {
    await pool.query("SELECT 1");
    await pool.end();
    return res.json({ ok: true });
  } catch (err) {
    await pool.end().catch(() => {});
    return res.status(400).json({ ok: false, error: String(err) });
  }
});

/** POST /setup/install — write .env, create schema, seed admin */
router.post("/install", async (req, res) => {
  const { dbHost, dbPort, dbName, dbUser, dbPassword, email, firstName, lastName, password, minSources, alertWebhookUrl } =
    req.body as Record<string, string>;

  if (!dbHost || !dbName || !dbUser || !dbPassword || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (password.length < 12) {
    return res.status(400).json({ error: "Password must be at least 12 characters" });
  }

  try {
    const demoTokenSecret = crypto.randomBytes(32).toString("hex");
    const databaseUrl = `postgres://${dbUser}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort || 5432}/${dbName}`;

    const envPath = path.join(process.cwd(), ".env");
    const envContent = [
      `DATABASE_URL=${databaseUrl}`,
      `DEMO_TOKEN_SECRET=${demoTokenSecret}`,
      `SETUP_COMPLETE=true`,
    ].join("\n") + "\n";

    fs.writeFileSync(envPath, envContent, { mode: 0o600 });

    // Re-initialize pool with new URL
    process.env.DATABASE_URL = databaseUrl;
    process.env.DEMO_TOKEN_SECRET = demoTokenSecret;
    process.env.SETUP_COMPLETE = "true";

    await createSchema();
    await seedSettings();

    if (minSources) await setSetting("minSources", minSources);
    if (alertWebhookUrl) await setSetting("alertWebhookUrl", alertWebhookUrl);

    const adminUser = await createUser({
      email, password, firstName, lastName, isAdmin: true,
    });
    await grantPermission(adminUser.id, PERM_SUPERADMIN);
    await grantPermission(adminUser.id, "CAN_VIEW_CANDLESERV");
    await grantPermission(adminUser.id, "CAN_MODIFY_CANDLESERV");

    await insertStreamEvent("candleserv", "on");

    // Two gates, written together so they agree: server.ts gates full startup
    // on app_settings.setupComplete, and app.ts gates the /setup wizard mount on
    // the SETUP_COMPLETE .env line written above.
    await setSetting("setupComplete", "true");

    log("[setup] install complete");
    return res.json({ ok: true });
  } catch (err) {
    logError("[setup] install failed:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
