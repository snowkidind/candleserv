# candleserv

Self-contained 1-minute OHLCV candle store for Bitcoin. Collects from five public exchange REST APIs (Binance, Bybit, Kraken, Coinbase, Bitfinex), reconciles them into a composite, stores to PostgreSQL, heals gaps automatically, and serves any requester via REST.

## Requirements

- Node.js 20+
- PostgreSQL
- pm2 (`npm install -g pm2`)
- Redis (optional — auto-detected on localhost:6379)

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

## Read-only instances (non-destructive access)

Multiple read-only instances can connect to the same production database. They can view all candle data and use the monitor UI, but cannot write candle data, trigger heals, modify config, or manage API keys. Only the master (production) instance runs the collector and writes data.

Enforcement is at two layers:

- **PostgreSQL role** — the read-only user has `SELECT` on all tables and write access only to `sessions` (required for monitor login/logout to function).
- **Application flag** — `READONLY_MODE=true` suppresses all background workers and blocks all HTTP mutation endpoints at the app level.

### Step 1 — Create the read-only PostgreSQL role (run once on the production DB)

Connect to the production `candleserv` database as a superuser and run:

```sql
-- Create the role
CREATE ROLE candleserv_ro LOGIN PASSWORD '<choose a strong password>';
GRANT CONNECT ON DATABASE candleserv TO candleserv_ro;
GRANT USAGE ON SCHEMA public TO candleserv_ro;

-- Read access to all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO candleserv_ro;

-- Write access to sessions only (required for monitor login/logout)
GRANT INSERT, UPDATE, DELETE ON TABLE sessions TO candleserv_ro;
GRANT USAGE, SELECT ON SEQUENCE sessions_id_seq TO candleserv_ro;

-- Ensure any future tables created by the master are also readable
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO candleserv_ro;
```

To verify the role cannot write to candle tables:

```sql
SET ROLE candleserv_ro;
INSERT INTO candles_1m (timestamp) VALUES (NOW());  -- must fail: permission denied
INSERT INTO sessions ("sessionId") VALUES ('test'); -- must succeed
RESET ROLE;
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
