import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./pool.js";
import { log } from "../lib/log.js";
import { SYMBOL_MAP } from "../adapters/symbolMap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// src/db/schema.ts → ../../schema/func.sql (works for both src/ and dist/ layouts)
const FUNC_SQL_PATH = path.resolve(__dirname, "..", "..", "schema", "func.sql");

const DDL = `
CREATE TABLE IF NOT EXISTS candles_1m (
  "currency"             varchar      NOT NULL DEFAULT 'BTC',
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
  PRIMARY KEY ("currency", "timestamp")
);
-- Idempotent migration for pre-multi-currency installs (Phase 12). On a fresh
-- DB the CREATE above already has the column + composite PK; on the existing
-- 7.42M-row BTC table this ALTER adds the column, and the PK rebuild
-- timestamp → (currency, timestamp) is a separate heavy Phase-12 step.
ALTER TABLE candles_1m ADD COLUMN IF NOT EXISTS "currency" varchar NOT NULL DEFAULT 'BTC';
DROP INDEX IF EXISTS candles_1m_timestamp_desc;
CREATE INDEX IF NOT EXISTS candles_1m_curr_ts_desc ON candles_1m ("currency", "timestamp" DESC);

CREATE TABLE IF NOT EXISTS candles_1m_sources (
  "currency"       varchar      NOT NULL DEFAULT 'BTC',
  "timestamp"      timestamptz  NOT NULL,
  "source"         varchar      NOT NULL,
  "open"           numeric      NOT NULL,
  "high"           numeric      NOT NULL,
  "low"            numeric      NOT NULL,
  "close"          numeric      NOT NULL,
  "volume"         numeric      NOT NULL,
  "rejected"       boolean      NOT NULL DEFAULT false,
  "rejectedReason" varchar,
  "usedInFormula"  boolean,
  "createdAt"      timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt"      timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("currency", "timestamp", "source")
);
-- Idempotent migrations for pre-existing installs. These ADD COLUMNs MUST run
-- BEFORE the index below: CREATE TABLE IF NOT EXISTS no-ops on an existing table,
-- so on a pre-multi-currency DB the "currency" column does not exist until added
-- here — and candles_1m_sources_curr_ts_desc references it.
ALTER TABLE candles_1m_sources ADD COLUMN IF NOT EXISTS "usedInFormula" boolean;
ALTER TABLE candles_1m_sources ADD COLUMN IF NOT EXISTS "createdAt"     timestamptz NOT NULL DEFAULT NOW();
ALTER TABLE candles_1m_sources ADD COLUMN IF NOT EXISTS "updatedAt"     timestamptz NOT NULL DEFAULT NOW();
-- Multi-currency Phase 1 (Phase 12 migration). PK rebuild → (currency, timestamp, source) is a separate heavy step.
ALTER TABLE candles_1m_sources ADD COLUMN IF NOT EXISTS "currency"      varchar NOT NULL DEFAULT 'BTC';
DROP INDEX IF EXISTS candles_1m_sources_ts_desc;
CREATE INDEX IF NOT EXISTS candles_1m_sources_curr_ts_desc ON candles_1m_sources ("currency", "timestamp" DESC);

-- Per-venue local USDT/USD rate paired with each candle. The peg is per-venue
-- and asset-independent, so this table stays currency-agnostic: one rate row per
-- (minute, venue) is shared across every currency fetched from that venue
-- (multi-currency D-STABLE-FK).
--
-- The former FK to candles_1m_sources ("timestamp","source") is DROPPED: once
-- that table's PK gains "currency", ("timestamp","source") is no longer a unique
-- target, so Postgres cannot keep the FK. The soft invariant — a stable-rate row
-- implies SOME candle row existed for that (minute, venue) — is now preserved by
-- collector ordering, not by the FK. The ON DELETE CASCADE it provided is
-- replaced by an explicit stable-rates prune (Phase 10.6).
CREATE TABLE IF NOT EXISTS stable_rates_1m_sources (
  "timestamp"      timestamptz  NOT NULL,
  "source"         varchar      NOT NULL,
  "rate"           numeric      NOT NULL,
  "pegSourcePair"  varchar      NOT NULL,
  "rejected"       boolean      NOT NULL DEFAULT false,
  "rejectedReason" varchar,
  "createdAt"      timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt"      timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("timestamp", "source")
);
-- Idempotent migration: drop the old FK on pre-multi-currency installs (default
-- constraint name). Phase 12 handles any non-default name explicitly.
ALTER TABLE stable_rates_1m_sources DROP CONSTRAINT IF EXISTS stable_rates_1m_sources_timestamp_source_fkey;
CREATE INDEX IF NOT EXISTS stable_rates_1m_sources_ts_desc
  ON stable_rates_1m_sources ("timestamp" DESC);

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
  "currency"         varchar      NOT NULL DEFAULT 'BTC',
  "timestamp"        timestamptz  NOT NULL,
  "durationMinutes"  smallint     NOT NULL DEFAULT 1,
  "state"            varchar      NOT NULL DEFAULT 'detected',
  "sourcesAvailable" integer      NOT NULL DEFAULT 0,
  "alertSent"        boolean      NOT NULL DEFAULT false,
  "detectedAt"       timestamptz  NOT NULL DEFAULT NOW(),
  "healedAt"         timestamptz,
  "updatedAt"        timestamptz  NOT NULL DEFAULT NOW(),
  UNIQUE ("currency", "timestamp")
);
-- Idempotent migration (Phase 12): add currency. The old single-column unique on
-- "timestamp" (gaps_timestamp_key) is superseded by the composite unique above;
-- Phase 12 drops the old constraint by name.
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS "currency" varchar NOT NULL DEFAULT 'BTC';
DROP INDEX IF EXISTS gaps_state_ts;
DROP INDEX IF EXISTS gaps_ts;
CREATE INDEX IF NOT EXISTS gaps_curr_state_ts ON gaps ("currency", "state", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS gaps_curr_ts ON gaps ("currency", "timestamp" DESC);

-- Currency control plane (multi-currency Phase 1). "currencies" = one row per
-- supported asset (chain on/off + per-token premium toggle + temporal floor).
CREATE TABLE IF NOT EXISTS currencies (
  "code"           varchar      PRIMARY KEY,             -- 'BTC','ETH','TON','TRX','SOL','BNB'
  "displayName"    varchar      NOT NULL,
  "enabled"        boolean      NOT NULL DEFAULT false,  -- chain on/off (Feeds tab)
  "premiumEnabled" boolean      NOT NULL DEFAULT true,   -- D2 per-token premium-offset toggle
  "flatFillEmpty"  boolean      NOT NULL DEFAULT false,  -- D-FLATFILL: empty minute → carry prev close (thin tokens); false → empty = failure/strike (BTC + liquid)
  "minSources"     smallint,                             -- nullable → fall back to app_settings.minSources
  "inceptionTs"    timestamptz,                          -- B3 temporal floor; NULL → consumers COALESCE to now-90d, never epoch
  "createdAt"      timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt"      timestamptz  NOT NULL DEFAULT NOW()
);

-- "currency_sources" = the Feeds-tab per-token formula + venue symbol map.
-- Effective live fetch set = rows where (available AND enabled), minus venues in
-- the global formula_changes.excludedSources kill switch.
CREATE TABLE IF NOT EXISTS currency_sources (
  "currency"  varchar      NOT NULL REFERENCES currencies("code") ON DELETE CASCADE,
  "source"    varchar      NOT NULL,                 -- adapter name (registry.ts SOURCE_NAMES)
  "symbol"    varchar      NOT NULL,                 -- venue symbol, e.g. 'ETHUSDT','XBTUSD'
  "available" boolean      NOT NULL DEFAULT false,   -- probed: does this venue list this pair (host-dependent)
  "enabled"   boolean      NOT NULL DEFAULT false,   -- operator: sync this (currency, source)
  "createdAt" timestamptz  NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("currency", "source")
);

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

CREATE TABLE IF NOT EXISTS formula_changes (
  "exchange"         varchar     NOT NULL,
  "setOrUnset"       varchar     NOT NULL CHECK ("setOrUnset" IN ('set', 'unset')),
  "by"               varchar     NOT NULL,
  "reason"           text,
  "statsAtExclusion" jsonb,
  "createdAt"        timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS formula_changes_exchange_ts ON formula_changes ("exchange", "createdAt" DESC);

-- General operator/system audit log. Unlike formula_changes (which is the live
-- source of truth for the global formula), this is purely append-only history:
-- every admin mutation (feed toggle, currency enable, formula change, repair,
-- config edit, API key lifecycle) writes a row here for the operator audit view.
CREATE TABLE IF NOT EXISTS admin_actions (
  "id"        serial       PRIMARY KEY,
  "actor"     varchar      NOT NULL,   -- user email / "manual:<email>" / "auto-suspend"
  "action"    varchar      NOT NULL,   -- e.g. 'feed.disable', 'currency.update', 'formula.exclude'
  "target"    varchar,                 -- e.g. 'TON/bitfinex', 'ETH', 'binance'
  "detail"    jsonb,                   -- arbitrary context for the action
  "createdAt" timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_actions_ts ON admin_actions ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS admin_actions_action_ts ON admin_actions ("action", "createdAt" DESC);

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
  // How far back (days) a repair job may reach. Default 180 = the per-venue
  // SOURCE archive prune horizon. Raise for a one-off deep backfill: repair
  // re-fetches the older window from the exchange and recomposes candles_1m
  // (kept forever); the re-fetched source rows still prune at 180d. Read
  // cache-free at repair time (lib/retention.ts); set via the cli (ctl.ts
  // `horizon` / menu `h`) or the /monitor/config admin panel.
  repairHorizonDays: "180",
  // Kill-switch for source-archive pruning. "true" → daily maintenance skips
  // pruneSourceCandles + pruneOldStableRates (preserves a deep backfill's
  // source/pegs for recompose-only). Read cache-free (lib/retention.ts).
  // Temporary until per-currency sourceRetentionDays lands.
  sourcePrunePaused: "false",
  // Public demo mode (Phase 10). IS_DEMO can also be forced via the env var of
  // the same name (env wins — see lib/demoMode.ts). When demo: api-key auth off,
  // monitor reads require a same-origin signed page token, limit/n clamped to
  // 200, optional IP rate-limit, ≤180d retention, Candles-only UI.
  IS_DEMO: "false",
  rateLimitEnabled: "false",
  rateLimitPerMinute: "120",
};

// Multi-currency Phase 1.9 seed. BTC is the working baseline (enabled, its feeds
// enabled); majors are seeded disabled until an operator turns them on from the
// Feeds tab. currency_sources.available stays false everywhere until the Phase-2
// per-host availability probe runs. inceptionTs left NULL (consumers COALESCE to
// now-90d); the real candleserv migration seeds BTC inceptionTs = 2012-04-18.
const CURRENCY_META: Record<string, { displayName: string }> = {
  BTC: { displayName: "Bitcoin" },
  ETH: { displayName: "Ethereum" },
  SOL: { displayName: "Solana" },
  TRX: { displayName: "TRON" },
  TON: { displayName: "Toncoin" },
  BNB: { displayName: "BNB" },
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
  await seedCurrencies();
}

export async function seedCurrencies(): Promise<void> {
  for (const [code, sources] of Object.entries(SYMBOL_MAP)) {
    const meta = CURRENCY_META[code];
    if (!meta) continue;
    const enabled = code === "BTC"; // BTC is the working baseline; majors off until probed/enabled
    await query(
      `INSERT INTO currencies ("code", "displayName", "enabled", "premiumEnabled")
       VALUES ($1, $2, $3, true)
       ON CONFLICT ("code") DO NOTHING`,
      [code, meta.displayName, enabled]
    );

    for (const [source, symbol] of Object.entries(sources)) {
      await query(
        `INSERT INTO currency_sources ("currency", "source", "symbol", "available", "enabled")
         VALUES ($1, $2, $3, false, $4)
         ON CONFLICT ("currency", "source") DO NOTHING`,
        [code, source, symbol, enabled]
      );
    }
  }
  log("[schema] currencies + currency_sources seeded");
}
