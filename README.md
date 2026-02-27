# candleserv

Self-contained 1-minute OHLCV candle store for Bitcoin. Collects from five public exchange REST APIs (Binance, Bybit, Kraken, Coinbase, Bitfinex), reconciles them into a composite, stores to PostgreSQL, heals gaps automatically, and serves any requester via REST.

Candleserv has no knowledge of the trading system that consumes it. It stores candles and serves candles. It could be published as a standalone open-source tool.

---

## Requirements

- Node.js 20+
- PostgreSQL (any version supporting `timestamptz` and `serial`)
- pm2 (`npm install -g pm2`)
- Redis (optional — auto-detected on localhost:6379)

---

## Quick start

```bash
git clone https://github.com/snowkidind/candleserv
cd candleserv
npm install
cd frontend && npm install && npm run build && cd ..
pm2 start npm --name candleserv -- start
```

Open `http://localhost:3007/setup` and follow the four-step wizard. Default port is 3007; set `PORT` in `.env` before starting to change it.

---

## Architecture

### Tech stack

- **Backend:** Node.js + TypeScript + Express
- **Frontend:** React 19, Vite, TanStack Router/Query, Tailwind CSS, TradingView Lightweight Charts
- **Database:** PostgreSQL (owned exclusively by candleserv)
- **Cache:** Redis (optional — bypassed if unavailable)
- **Process manager:** pm2

### Directory layout

```
src/
  adapters/         Exchange fetch adapters (binance, bybit, kraken, coinbase, bitfinex)
  db/               Database access layer (candles, gaps, errors, sessions, schema, etc.)
  lib/              Core logic (collector, composite, healer, gapDetector, emitter, redis)
  middleware/       Auth middleware (API key, session)
  routes/
    health.ts       GET /health (unauthenticated)
    setup.ts        Setup wizard routes
    v1/candles.ts   API consumer routes (API key auth)
    monitor/        Monitor UI routes (session auth)
  types/            TypeScript interfaces
frontend/           React SPA (monitor UI)
scripts/            Utility scripts (rederive, testCaller)
```

### Data flow

1. **Collector** fires at :04 past each minute, fetches the just-closed 1m candle from all five exchanges in parallel (6s per-source timeout).
2. **Input guards** reject bad data per-source (zero values, invalid OHLC geometry, statistical outliers).
3. **Composite engine** merges surviving sources into a single canonical candle and writes it to `candles_1m`.
4. **SSE emitter** broadcasts the new candle to connected monitor and API consumers.
5. **Gap detector** runs on startup (7-day scan) and hourly (1-day scan), healing any missing rows.
6. **Backfill** on first startup fills the last 3 months from Binance.

### Database tables

| Table | Purpose | Retention |
|-------|---------|-----------|
| `candles_1m` | Composite candles, one row per UTC minute | Indefinite |
| `candles_1m_sources` | Per-source raw candles for debugging | 30 days |
| `gaps` | Detected/healed gap records | Indefinite |
| `stream_events` | Source connection state transitions | Indefinite |
| `service_errors` | Internal error log | 90 days |
| `api_keys` | API consumer credentials | Indefinite |
| `users` / `sessions` / `user_permissions` | Monitor authentication | Sessions pruned daily |
| `app_settings` | Runtime configuration | Indefinite |

---

## Data sources

| Source | Pair | Denomination | Max candles/call |
|--------|------|-------------|-----------------|
| Binance | BTCUSDT | USDT | 1000 |
| Bybit | BTCUSDT | USDT | 1000 |
| Kraken | XBTUSD | USD (internal ledger) | 720 |
| Coinbase | BTC-USDC | USDC | 300 |
| Bitfinex | tBTCUSD | USDT (labeled USD) | 1000 |

All five are free, public, no API key required.

**Currency basis:** There is no true USD source. Binance, Bybit, and Bitfinex settle in Tether. Coinbase settles in USDC. Kraken's "USD" is an internal unit. The composite does not normalize across these bases — per-source deviation from the median is tracked empirically, and the confidence score reflects how tightly the sources agreed.

---

## Composite algorithm

### Step 1 — Input guards

Applied per-source before composite assembly. Rejections are recorded in `candles_1m_sources` with a `rejectedReason`.

**1a. Zero guard** — Reject if any of open/high/low/close is zero or negative. `rejectedReason = "zero_value"`

**1b. OHLC consistency guard** — Reject if the candlestick geometry is impossible (low > high, high < open, etc). `rejectedReason = "ohlc_invalid"`

**1c. Outlier guard** — Runs only when `sourceCount >= minSources` (default 3). Computes the median close across remaining sources and the population standard deviation (σ) with a $10 floor. Any source whose close deviates more than 1σ from the median is rejected. `rejectedReason = "outlier"`

The σ used by the outlier guard is derived from the trailing 24h of composite close prices (1440 rows), not just the current minute's sources. This prevents a single bad tick from distorting the threshold. If fewer than 1440 rows exist (cold start), the $10 floor applies.

### Step 2 — Composite OHLCV calculation

Using only sources that passed all guards:

| Field | Method |
|-------|--------|
| `open` | Median of source opens |
| `close` | Median of source closes |
| `high` | Taken from the **dominant source** (trailing volume leader over the last 10 accepted minutes). Extended upward if needed to contain the median-derived body. |
| `low` | Taken from the **dominant source**. Extended downward if needed to contain the median-derived body. |
| `volume` | Sum of all accepted source volumes |

**Why median for O/C and dominant-source for H/L:** Open and close represent consensus price — median gives a robust central estimate that resists outliers. High and low represent extreme wicks within the candle, which are exchange-specific microstructure events. Taking these from the highest-volume exchange (which has the deepest orderbook and most representative price discovery) produces more meaningful wicks than a max/min across all exchanges, which would accumulate noise from thin-book venues.

The dominant source is selected by summing volume across the last 10 accepted source-candle rows in `candles_1m_sources` and picking the source with the highest total. If that source was rejected or absent for the current minute, the system falls back to whichever accepted source had the highest volume this tick.

### Step 3 — Volume normalization

**`sourceCountBaseline`** = mode (most common value) of `sourceCount` over the trailing 1440 rows (24h). Represents what "normal" looks like recently. Cold-start default: 5.

**`volumeNormalized`** = `volume × (sourceCountBaseline / sourceCount)`. When a source drops out, the raw volume sum naturally falls. `volumeNormalized` scales the sum up to compensate, preventing a source outage from producing a false volume collapse in downstream signal analysis. When all sources are present (`sourceCount = sourceCountBaseline`), both columns are identical.

The raw `volume` column is always preserved alongside `volumeNormalized`. Use raw volume when you need an unmodified number; use normalized volume for momentum/signal work.

**Known limitation:** Volume is summed across exchanges that may share liquidity (e.g. arbitrage, market makers mirroring orders). Some double-counting is likely. Additionally, the exchanges price Bitcoin in different synthetic dollar units (USDT, USDC, internal USD) that are not strictly equivalent. `volumeNormalized` addresses source dropout continuity but does not correct the underlying currency basis mismatch. These are acceptable tradeoffs for the intended use case.

### Step 4 — Confidence score

A single 0.0–1.0 value stored on every candle:

```
sourceRatio   = sourceCount / sourceCountBaseline
rejectedRatio = rejectedCount / sourcesAttempted
confidence    = sourceRatio × (1 - rejectedRatio)
```

| Scenario | Confidence |
|----------|------------|
| 5/5 sources, none rejected | 1.0 |
| 4/5 sources, none rejected | 0.8 |
| 5/5 sources, 1 rejected (outlier) | 0.8 |
| 3/5 sources, 2 rejected | 0.36 |

If only 1 source survives all guards, the composite is still written (a degraded candle is better than a gap) and an error is logged.

### Sources bitmask

Each accepted source sets a bit in the integer `sources` column:

| Bit | Source |
|-----|--------|
| 0 | Binance |
| 1 | Bybit |
| 2 | Kraken |
| 3 | Coinbase |
| 4 | Bitfinex |

---

## Handling exchange dropouts and self-repair

### Source dropout detection

A dropout is distinct from a gap — the candle row exists but `sourceCount` has fallen below `sourceCountBaseline`. When `sourceCount < sourceCountBaseline` for 3+ consecutive candles, the collector logs a warning and fires a webhook alert (`type: "source_degraded"`) if configured. Recovery back to baseline triggers a `source_recovered` alert.

### Source auto-pause

If a single source accumulates more than `sourceAutoSuspendThreshold` (default: 10) guard rejections or fetch failures within a rolling 24-hour window, it is automatically paused — excluded from all future collection runs. The collector tracks per-source failure timestamps in memory and prunes entries older than 24h on each check. A paused source's bit is cleared from future `sources` bitmasks.

Auto-pause fires a webhook (`type: "source_paused"`) and writes a `stream_events` row. The source remains paused until manually re-enabled from the Admin tab.

### Gap detection

Gaps are missing rows in `candles_1m`. Detection runs:
- On startup (scan last 7 days)
- Hourly (scan last 24 hours)
- On-demand via `POST /monitor/heal`

Detection uses `generate_series` against the expected minute sequence and identifies any timestamps with no corresponding row.

### Gap healing

For each detected gap, the healer fetches the missing minute from Binance and upserts a single-source candle with `confidence = 0.2`. Gaps transition through states: `detected` → `healing` → `healed` or `unresolvable`. Healed gaps are retained as history.

If more than 100 gaps are pending (indicating a fresh database), healing defers to the backfill process rather than issuing thousands of individual requests.

### Backfill

On first startup, if fewer than 3 months of data exist, the backfill process scans day-by-day from 90 days ago to present. For each day with fewer than 1440 rows, it fetches the full day from Binance in two API calls (1000 + 440 candles) and inserts any missing rows. Existing rows are never overwritten — `INSERT ... ON CONFLICT DO NOTHING`.

Backfill runs concurrently with the live collector. After completion it clears stale detected gaps and rescans the last 7 days.

### Collection deadline

The collector enforces a 15-second deadline from the minute boundary. If the composite has not been written by the deadline, the minute is skipped and left for the gap healer. An overlap guard prevents concurrent collection runs.

### Webhook alerting

If `alertWebhookUrl` is configured in `app_settings`, the system sends HTTP POST alerts for:
- `gap_detected` — timestamp and duration of the missing candle
- `source_degraded` — sourceCount has dropped below baseline for 3+ consecutive minutes
- `source_recovered` — sourceCount returned to baseline
- `source_paused` — a source was auto-paused after exceeding the failure threshold

Repeat-alert suppression prevents the same gap from firing multiple webhooks across detection runs.

---

## REST API

### Authentication

API consumer routes under `/v1/*` require API key authentication via the `Authorization` header.

**Token construction (client side):**

```javascript
const nonce = Date.now();
const enc   = SHA256(secret + ':' + nonce).toString('hex');
const chop  = enc.slice(0, 19);
const raw   = api_key + ':' + nonce + ':' + chop;
const token = Buffer.from(raw, 'utf8').toString('base64');
// sent as: Authorization: <token>
```

Nonce must be monotonically increasing (replay protection). The secret never leaves the client.

### Candle endpoints

```
GET /v1/candles?tf=<tf>&endingAt=<iso>&limit=<n>
GET /v1/candles/latest?tf=<tf>&n=<count>
```

Maximum limit: 5000. All higher timeframes are aggregated from 1m rows on read.

**Supported timeframes:** `1m`, `5m`, `10m`, `15m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, `3d`, `7d`, `30d`

The `7d` timeframe aligns to Monday 00:00 UTC. The `30d` timeframe aligns to calendar month boundaries (actual width varies 28–31 days).

**Response format:**

```json
{
  "candles": [
    {
      "timestamp": 1708500000000,
      "open": 45000.50,
      "high": 45200.75,
      "low": 44900.25,
      "close": 45100.00,
      "volume": 1250000.00,
      "volumeNormalized": 1562500.00,
      "sourceCount": 4,
      "sourceCountBaseline": 5,
      "sources": 23,
      "confidence": 0.8
    }
  ]
}
```

### SSE streams

**Monitor stream** (session cookie, all timeframes):
```
GET /candles/stream?tf=<tf>
```

**API consumer stream** (API key, 1m only, rolling buffer):
```
GET /v1/candles/stream?n=<count>
```

On connect, immediately pushes the last N candles. On each new composite, pushes the latest N candles. Range: 1–200.

**Subscription check:**
```
GET /v1/candles/subscriptions
```

### Operational endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Status, uptime, latest candle, sources active, gaps pending |
| `GET /monitor/sources` | Session | Per-source state, last fetch, consecutive errors, last close |
| `GET /monitor/stats` | Session | Total rows, oldest/newest candle, sourceCount distribution, collection latency |
| `GET /monitor/gaps` | Session | Gap records with state and heal timestamps |
| `GET /monitor/errors` | Session | Error log with service/time/message filters |
| `GET /monitor/stream-events` | Session | Connection state history for the timeline |

---

## Configuration

### `.env` reference

```
DATABASE_URL=postgres://user:pass@host:port/dbname   # written by setup wizard
SESSION_SECRET=<64-char random hex>                   # auto-generated at setup
SETUP_COMPLETE=true                                   # gates the setup wizard
PORT=3007                                             # set before first start if needed
READONLY_MODE=true                                    # for read-only instances (see below)
```

### `app_settings` (managed from Admin tab)

| Key | Default | Description |
|-----|---------|-------------|
| `minSources` | `3` | Minimum sources for full-confidence composite; also the threshold before the outlier guard fires |
| `alertWebhookUrl` | `""` | HTTP POST target for gap/source alerts (empty = disabled) |
| `sourceAutoSuspendThreshold` | `10` | Guard rejections or fetch failures in 24h before auto-pause |
| `redisUrl` | `""` | Redis URL (auto-detected on localhost:6379 if blank) |

Settings are cached in Redis with a 1-hour TTL. Writes via the Admin tab immediately invalidate the cache.

---

## Connecting downstream services

Each service that consumes candleserv gets its own API key issued from the Admin tab.

Add to the consumer's `.env`:

```
CANDLESERV_URL=http://localhost:3007
CANDLESERV_API_KEY=<key>
CANDLESERV_SECRET=<secret>
```

The secret is shown once at issue time and cannot be retrieved again. If lost, revoke and reissue.

### Testing the connection

```bash
CANDLESERV_URL=http://localhost:3007 \
CANDLESERV_API_KEY=<key> \
CANDLESERV_SECRET=<secret> \
npx tsx scripts/testCaller.ts
```

Or simply:

```bash
curl http://localhost:3007/health
```

---

## Caching (Redis)

Popular queries are cached in Redis. Cache keys expire at the start of the next boundary for the requested timeframe (e.g. a `1h` query expires at the next hour). Historical range queries that don't overlap the current open candle receive a 24-hour TTL.

Redis is optional. If unavailable, all queries hit Postgres directly.

---

## Monitor UI

A built-in browser-based admin interface served at `/monitor` with four tabs:

- **Candles** — Real-time candlestick chart (TradingView Lightweight Charts), timeframe selector, historical query, source quality overlay
- **Connections** — Per-exchange status cards with state badges, connection timeline, collection latency, heal button
- **Errors** — Filterable error log table with auto-refresh
- **Admin** — API key management, app settings, source management, user management (superadmin only)

Authentication uses session cookies (PBKDF2-SHA512 passwords, 7-day session expiry).

### Permissions

| Permission | Description |
|-----------|-------------|
| `SUPERADMIN` | Full access, single user |
| `CAN_VIEW_CANDLESERV` | Read-only access to monitor |
| `CAN_MODIFY_CANDLESERV` | Can trigger heals, manage keys, change config |

---

## Setup wizard

On first start, candleserv serves a setup wizard at `/setup`. All other routes return 503 until setup completes. The wizard has four steps:

1. **Database connection** — host, port, database name, username, password. Test button validates before proceeding.
2. **Admin account** — email and password (min 12 characters). Receives `SUPERADMIN`.
3. **Service configuration** — minimum sources, alert webhook URL. Defaults are safe.
4. **Confirm and install** — creates tables, seeds settings, hashes password, writes `.env`.

No restart is required after setup. To reset to factory state, delete `.env` and restart.

---

## Read-only instances (non-destructive access)

Multiple read-only instances can connect to the same production database. They can view all candle data and use the monitor UI, but cannot write candle data, trigger heals, modify config, or manage API keys. Only the master (production) instance runs the collector and writes data.

Enforcement is at two layers:

- **PostgreSQL role** — the read-only user has `SELECT` on all tables and write access only to `sessions` (required for monitor login/logout and session keepalive to function).
- **Application flag** — `READONLY_MODE=true` suppresses all background workers (collector, healer, gap detector, schema migration) and blocks all HTTP mutation endpoints at the app level.

### Required session table permissions

The `sessions` table requires `SELECT`, `INSERT`, `UPDATE`, and `DELETE` for the read-only role. Without `UPDATE`, the session `lastSeen` timestamp cannot be refreshed on each request. This causes `trackSession` to fail, which can result in a new anonymous session cookie being issued that silently overwrites the browser's authenticated cookie — producing spurious 401s that persist until the user logs out and back in.

### Step 1 — Create the read-only PostgreSQL role (run once on the production DB)

Connect to the production `candleserv` database as a superuser and run:

```sql
-- Create the role
CREATE ROLE candleserv_ro LOGIN PASSWORD '<choose a strong password>';
GRANT CONNECT ON DATABASE candleserv TO candleserv_ro;
GRANT USAGE ON SCHEMA public TO candleserv_ro;

-- Read access to all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO candleserv_ro;

-- Write access to sessions only (required for monitor login/logout and session keepalive)
GRANT INSERT, UPDATE, DELETE ON TABLE sessions TO candleserv_ro;
GRANT USAGE, SELECT ON SEQUENCE sessions_id_seq TO candleserv_ro;

-- Ensure any future tables created by the master are also readable
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO candleserv_ro;
```

> **Note:** `ALTER DEFAULT PRIVILEGES` only covers tables created after that command runs. If new tables are added to the schema later (e.g. `service_events`), re-run the following to catch up:
> ```sql
> GRANT SELECT ON ALL TABLES IN SCHEMA public TO candleserv_ro;
> ```

To verify the role cannot write to candle tables but can manage sessions:

```sql
SET ROLE candleserv_ro;
INSERT INTO candles_1m (timestamp) VALUES (NOW());                     -- must fail: permission denied
INSERT INTO sessions ("sessionId") VALUES ('test');                    -- must succeed
UPDATE sessions SET "lastSeen" = NOW() WHERE "sessionId" = 'test';    -- must succeed
DELETE FROM sessions WHERE "sessionId" = 'test';                      -- must succeed
RESET ROLE;
```

### Stale session cleanup

Each login creates a new session row. The master instance prunes them daily (authenticated sessions older than 7 days). If sessions accumulate — for example from repeated logout/login cycles while debugging the 401 issue — clean them up manually:

```sql
-- Keep only the most recent session per user, delete the rest
DELETE FROM sessions
WHERE id NOT IN (
  SELECT MAX(id) FROM sessions WHERE "userId" IS NOT NULL GROUP BY "userId"
)
AND "userId" IS NOT NULL;
```

### Step 2 — Configure the read-only instance

Create a `.env` in the candleserv root on the dev/secondary machine:

```
DATABASE_URL=postgres://candleserv_ro:<password>@<production-host>:5432/candleserv
SESSION_SECRET=<64-char random hex unique to this instance>
SETUP_COMPLETE=true
READONLY_MODE=true
PORT=3007
```

`SETUP_COMPLETE=true` skips the setup wizard — the production database is already initialised.

Generate a unique `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3 — Start

```bash
npm run dev
# or
pm2 start npm --name candleserv-dev -- start
```

On startup the log will confirm:

```
[server] READONLY_MODE — collector, healer, gap detector, and maintenance disabled
```

### What works in read-only mode

| Feature | Available |
|---------|-----------|
| Monitor UI (all tabs) | Yes |
| Candles tab — live SSE stream | Yes |
| Candles tab — historical scroll | Yes |
| Connections tab | Yes |
| Errors tab | Yes |
| Admin tab (view only) | Yes |
| `/v1/candles/*` API endpoints | Yes |
| `/health` | Yes |
| Monitor login / logout | Yes |
| Trigger heal (`POST /monitor/heal`) | No — 403 |
| Modify config (`POST /monitor/config`) | No — 403 |
| API key management | No — 403 |
| Resume paused source | No — 403 |
| Collector / healer / gap detector | Not started |

### Notes

- Multiple read-only instances can run simultaneously — each has its own session cookie and `SESSION_SECRET`.
- Sessions created by read-only instances are stored in the shared `sessions` table and pruned by the production instance's daily maintenance job. This is harmless.
- The read-only instance never writes candle data, gap records, stream events, or app settings — enforcement is at both the PostgreSQL role level and the application middleware level.
