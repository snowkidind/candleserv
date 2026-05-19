import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./pool.js";
import { log } from "../lib/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// src/db/schema.ts → ../../schema/func.sql (works for both src/ and dist/ layouts)
const FUNC_SQL_PATH = path.resolve(__dirname, "..", "..", "schema", "func.sql");

const DDL = `
CREATE TABLE IF NOT EXISTS candles_1m (
  "timestamp"            timestamptz  NOT NULL,
  "open"                 numeric      NOT NULL,
  "high"                 numeric      NOT NULL,
  "low"                  numeric      NOT NULL,
  "close"                numeric      NOT NULL,
  "volume"               numeric      NOT NULL,
  "volumeNormalized"     numeric      NOT NULL,
  "sourceCount"          smallint     NOT NULL DEFAULT 0,
  "sourceCountBaseline"  smallint     NOT NULL DEFAULT 0,
  "sources"              integer      NOT NULL DEFAULT 0,
  "confidence"           numeric      NOT NULL DEFAULT 0,
  "createdAt"            timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt"            timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("timestamp")
);
CREATE INDEX IF NOT EXISTS candles_1m_timestamp_desc ON candles_1m ("timestamp" DESC);

CREATE TABLE IF NOT EXISTS candles_1m_sources (
  "timestamp"      timestamptz  NOT NULL,
  "source"         varchar      NOT NULL,
  "open"           numeric      NOT NULL,
  "high"           numeric      NOT NULL,
  "low"            numeric      NOT NULL,
  "close"          numeric      NOT NULL,
  "volume"         numeric      NOT NULL,
  "rejected"       boolean      NOT NULL DEFAULT false,
  "rejectedReason" varchar,
  PRIMARY KEY ("timestamp", "source")
);
CREATE INDEX IF NOT EXISTS candles_1m_sources_ts_desc ON candles_1m_sources ("timestamp" DESC);

CREATE TABLE IF NOT EXISTS service_errors (
  "id"        serial       PRIMARY KEY,
  "service"   text         NOT NULL,
  "location"  text         NOT NULL,
  "message"   text         NOT NULL,
  "stack"     text,
  "createdAt" timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS service_errors_service_ts ON service_errors ("service", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS service_errors_ts ON service_errors ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS users (
  "id"            serial       PRIMARY KEY,
  "status"        varchar      NOT NULL DEFAULT 'active',
  "email"         varchar      NOT NULL UNIQUE,
  "firstName"     varchar,
  "lastName"      varchar,
  "isAdmin"       boolean      NOT NULL DEFAULT false,
  "password"      varchar      NOT NULL,
  "lastLogin"     timestamptz,
  "lastLoginFail" timestamptz,
  "createdAt"     timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt"     timestamptz  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  "id"        serial       PRIMARY KEY,
  "userId"    int,
  "sessionId" varchar      NOT NULL UNIQUE,
  "userAgent" json,
  "ip"        varchar,
  "createdAt" timestamptz  NOT NULL DEFAULT NOW(),
  "lastSeen"  timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions ("userId");

CREATE TABLE IF NOT EXISTS user_permissions (
  "id"        serial       PRIMARY KEY,
  "userId"    int          NOT NULL,
  "perm"      varchar      NOT NULL,
  "options"   varchar      NOT NULL DEFAULT '',
  "createdAt" timestamptz  NOT NULL DEFAULT NOW(),
  UNIQUE ("userId", "perm")
);

CREATE TABLE IF NOT EXISTS api_keys (
  "id"        serial       PRIMARY KEY,
  "label"     varchar      NOT NULL,
  "apiKey"    varchar      NOT NULL UNIQUE,
  "secret"    varchar      NOT NULL,
  "nonce"     bigint       NOT NULL DEFAULT 0,
  "enabled"   boolean      NOT NULL DEFAULT true,
  "lastSeen"  timestamptz,
  "createdAt" timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gaps (
  "id"               serial       PRIMARY KEY,
  "timestamp"        timestamptz  NOT NULL UNIQUE,
  "durationMinutes"  smallint     NOT NULL DEFAULT 1,
  "state"            varchar      NOT NULL DEFAULT 'detected',
  "sourcesAvailable" integer      NOT NULL DEFAULT 0,
  "alertSent"        boolean      NOT NULL DEFAULT false,
  "detectedAt"       timestamptz  NOT NULL DEFAULT NOW(),
  "healedAt"         timestamptz,
  "updatedAt"        timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gaps_state_ts ON gaps ("state", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS gaps_ts ON gaps ("timestamp" DESC);

CREATE TABLE IF NOT EXISTS stream_events (
  "id"        serial       PRIMARY KEY,
  "source"    text         NOT NULL,
  "state"     text         NOT NULL,
  "createdAt" timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS stream_events_source_ts ON stream_events ("source", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS stream_events_ts ON stream_events ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  "key"       varchar      NOT NULL PRIMARY KEY,
  "value"     text         NOT NULL,
  "updatedAt" timestamptz  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_events (
  "id"              serial       PRIMARY KEY,
  "type"            varchar      NOT NULL,
  "startedAt"       timestamptz  NOT NULL,
  "endedAt"         timestamptz  NOT NULL,
  "durationMinutes" integer      NOT NULL,
  "notes"           text,
  "createdAt"       timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS service_events_type_ts ON service_events ("type", "startedAt" DESC);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  minSources: "3",
  alertWebhookUrl: "",
  sourceAutoSuspendThreshold: "10",
  redisUrl: "",
};

export async function createSchema(): Promise<void> {
  log("[schema] creating tables...");
  await query(DDL);
  log("[schema] tables ready");
  await applyFunctions();
}

/**
 * Apply schema/func.sql — defines get_kline_minute/hour/day, the SQL functions
 * paperserv (and other consumers) call to fetch OHLCV ranges. Uses CREATE OR
 * REPLACE FUNCTION so this is idempotent and safe to re-run against an
 * already-initialized DB to repair missing functions.
 */
export async function applyFunctions(): Promise<void> {
  if (!fs.existsSync(FUNC_SQL_PATH)) {
    throw new Error(`[schema] schema/func.sql not found at ${FUNC_SQL_PATH}`);
  }
  log(`[schema] applying functions from ${FUNC_SQL_PATH}`);
  const sql = fs.readFileSync(FUNC_SQL_PATH, "utf8");
  await query(sql);
  log("[schema] functions ready");
}

export async function seedSettings(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO app_settings ("key", "value") VALUES ($1, $2) ON CONFLICT ("key") DO NOTHING`,
      [key, value]
    );
  }
  log("[schema] app_settings seeded");
}
