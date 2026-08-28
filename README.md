# candleserv

Self-contained 1-minute OHLCV **composite candle store**. Collects from up to eight public exchange REST APIs, normalizes each venue's stablecoin quote into real-USD space, reconciles them into a single canonical candle per minute, stores to PostgreSQL, heals gaps automatically, and serves any requester over REST.

Candleserv has no knowledge of the trading system that consumes it. It stores candles and serves candles. It owns its database exclusively and runs as a standalone open-source service.

candleserv is **multi-currency**: every table is keyed by `(currency, timestamp)` and the collector composes each enabled asset independently. BTC is the only enabled currency in a default install; the machinery (symbol map, per-venue feeds, peg layer) supports adding others.

---

## Requirements

- Node.js 20+
- PostgreSQL (any version supporting `timestamptz` and `serial`)
- pm2 (`npm install -g pm2`)
- Redis (optional — auto-detected on `localhost:6379`)

---

## Quick start

```bash
git clone https://github.com/snowkidind/candleserv
cd candleserv
npm install
cd frontend && npm install && npm run build && cd ..
pm2 start npm --name candleserv -- start
```

Open `http://localhost:3007/setup` and follow the wizard. Default port is 3007; set `PORT` in `.env` before starting to change it.

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
  adapters/         Per-venue fetch adapters + normalization profiles (registry.ts), symbol map
  db/               Database access layer (candles, stableRates, gaps, currencies, errors, sessions, schema, …)
  lib/              Core logic (collector, compose, composite, healer, gapDetector, repair, emitter, redis, premium)
  middleware/       Auth + gates (apiKeyAuth, sessionAuth, demoGate, demoRateLimit, premiumRateLimit, repairLock)
  routes/
    health.ts       GET /health (unauthenticated)
    setup.ts        Setup wizard routes
    v1/candles.ts   Candle consumer API (API key auth)
    v1/premium.ts   Premium-offset consumer API (API key auth)
    monitor/        Monitor UI routes (session auth)
    internal.ts     Localhost-only operator routes (cli/ctl.ts)
  types/            TypeScript interfaces
frontend/           React SPA (monitor UI)
cli/                Operator CLI (index → menu → ctl)
scripts/            Utility scripts (healGaps, reconcileGaps, synchronizeWithRemoteDb, rederive, migrateMultiCurrency, mintConsumerKey, testCaller)
docs/api/           Postman collection + environment + API README (served at /api-docs)
```

### Data flow

1. **Collector** fires at `:04` past each minute and composes BTC first (own 15s deadline), then any other enabled currencies (separate deadline), so an alt never delays BTC.
2. For each currency it fetches the just-closed 1m candle from every enabled venue in parallel, and — for USDT-quoted venues — the venue's **local stablecoin rate** for the same minute (the two are bundled: both halves commit or neither does).
3. **Input guards** reject bad data per-source (zero values, invalid OHLC geometry, statistical outliers — the outlier check runs in peg-normalized USD space).
4. **Composite engine** peg-normalizes each surviving source, applies the premium-offset correction, takes field-wise medians, and writes one row to `candles_1m` plus the per-source rows to `candles_1m_sources` and the paired rates to `stable_rates_1m_sources`.
5. **SSE emitter** broadcasts the new candle to connected monitor and API consumers.
6. **Gap detector** runs on startup (7-day scan) and hourly (1-day scan), healing missing rows.
7. **Backfill** on first startup fills ~90 days from the enabled venues.

### Database tables

| Table | Purpose | Retention |
|-------|---------|-----------|
| `candles_1m` | Composite candles, PK `(currency, timestamp)` | Indefinite |
| `candles_1m_sources` | Per-source raw candles, PK `(currency, timestamp, source)` | 180 days |
| `stable_rates_1m_sources` | Per-venue local USDT→USD rate, PK `(timestamp, source)` — currency-agnostic | 180 days |
| `currencies` | Enabled assets + per-currency settings (premiumEnabled, minSources, flatFillEmpty, inceptionTs) | Indefinite |
| `currency_sources` | Per-(currency, venue) symbol + availability + enabled flag (Feeds tab) | Indefinite |
| `gaps` | Detected/healing/healed/unresolvable gap records, unique `(currency, timestamp)` | Indefinite |
| `stream_events` / `service_events` | Source connection-state transitions / outage events | Indefinite |
| `formula_changes` | Global venue-exclusion (kill-switch) history | Indefinite |
| `service_errors` | Internal error log | 90 days |
| `admin_actions` | Operator audit log | Indefinite |
| `api_keys` | API consumer credentials | Indefinite |
| `users` / `sessions` / `user_permissions` | Monitor authentication | Sessions pruned daily |
| `app_settings` | Runtime configuration | Indefinite |

Only the composite *inputs* (`candles_1m_sources`, `stable_rates_1m_sources`) are pruned at 180 days — the composite itself is kept indefinitely.

---

## Data sources

Eight venue adapters ship in `src/adapters/registry.ts`. Each carries a **normalization profile** declaring whether it quotes BTC in real USD or in a stablecoin (and, if so, where to fetch that venue's own local stablecoin→USD rate).

| Venue | BTC pair | Quote | Peg source |
|-------|----------|-------|-----------|
| Binance | `BTCUSDT` | USDT | `USDCUSDT` (inverted) |
| Bybit | `BTCUSDT` | USDT | `USDTUSD` |
| Gate | `BTC_USDT` | USDT | `USDC_USDT` |
| Bitget | `BTCUSDT` | USDT | `USDCUSDT` (inverted) |
| Kraken | `XBTUSD` | USD-native | — |
| Coinbase | `BTC-USD` | USD-native | — |
| Bitfinex | `tBTCUSD` | USD-native (internally-redeemed USDT) | — |
| OKX | `BTC-USDT` | (disabled in this deployment) | — |

All are free, public, no API key required. **OKX is geo-restricted from some regions** (e.g. Thailand) and is disabled here — left in the registry but not collected. The working set is six to seven venues.

### There is no canonical USDT

USDT does not trade at exactly $1.00, and there is **no single USDT/USD rate** — only the local stablecoin price at each specific venue. Rather than pretend otherwise, candleserv fetches each USDT-quoted venue's *own* USDC×USDT (or USDT×USD) 1-minute close and uses it to convert that venue's BTC price into real-USD space before compositing. USD-native venues (Kraken, Coinbase) pass through untouched. Bitfinex is deliberately treated as USD-native even though its "USD" is internally-redeemed USDT — its basis is left to surface as signal (see [Premium offset](#premium-offset)).

This is the principle the whole composite is built around. The long-form study lives in `chit/articles/01_bitfinex_premium`. The per-venue USDT→USD rate described here is directly queryable via the [peg endpoints](#peg-endpoints).

---

## Composite algorithm

Per minute, per currency, using only sources that passed the guards:

**1. Input guards** (`applyGuards`) — recorded in `candles_1m_sources` with a `rejectedReason`:
- *zero guard* — any of O/H/L/C ≤ 0 → `zero_value`
- *OHLC consistency* — impossible geometry (low > high, high < open, …) → `ohlc_invalid`
- *outlier guard* — runs when surviving sources ≥ `minSources` (default 3). Compares each venue's **peg-normalized** close to the population median; rejects beyond σ (derived from the trailing 24h of composite closes, $10 floor) → `outlier`. Running the check in normalized USD space is what stops USD-native venues being rejected whenever USDT carries a premium.

**2. Peg adjustment** — each USDT venue's O/H/L/C is multiplied by its local stablecoin rate; USD-native venues are identity. After this step every venue is in approximate real-USD space. Volume is never peg-adjusted (price only). A USDT venue with no paired rate row for the minute is dropped (`missing_paired_rate`).

**3. Premium-offset correction** — for each field (O/H/L/C) and each venue, compute the **leave-one-out median** of the other venues (its consensus), and pull the venue's contribution `CORRECTION_FACTOR = 0.8` of the way toward consensus. This neutralizes per-venue basis while preserving real price moves. Gated per currency by `currencies.premiumEnabled`; skipped (plain medians) when fewer than 3 venues survive.

**4. Composite OHLC** = field-wise medians of the post-correction contributions, with a defensive guard that widens the wick to enclose the body.

**5. Volume** — raw sum across accepted sources, plus `volumeNormalized = volume × (sourceCountBaseline / sourceCount)` so a source dropout doesn't read as a volume collapse. Both columns are persisted.

**6. Confidence** — a single `[0,1]` value on every candle:
```
sourceRatio   = sourceCount / sourceCountBaseline
rejectedRatio = rejectedCount / sourcesAttempted
confidence    = sourceRatio × (1 − rejectedRatio)
```
where `sourceCountBaseline` is the 24h mode of `sourceCount`. The monitor renders confidence as candle opacity — degraded minutes look pale at a glance. If only one source survives, the composite is still written (a degraded candle beats a gap) and an error is logged.

### Sources bitmask

Each accepted venue sets a bit in the integer `sources` column. Bit numbers are part of the on-disk format and are append-only:

| Bit | Value | Source |  | Bit | Value | Source |
|-----|-------|--------|--|-----|-------|--------|
| 0 | 1 | binance |  | 4 | 16 | bitfinex |
| 1 | 2 | bybit |  | 5 | 32 | okx |
| 2 | 4 | kraken |  | 6 | 64 | gate |
| 3 | 8 | coinbase |  | 7 | 128 | bitget |

---

## Premium offset

The premium-offset correction (step 3 above) computes, per venue per field per minute, the signed-USD deviation from the cross-venue consensus — `pegged − leave-one-out-median(peers)`. Internally it's a transient used to pull contributions toward consensus, then discarded. But it's a meaningful signal in its own right: the **Bitfinex** slice in particular is a real-time read on tether-system / venue-specific stress, and no public index publishes per-venue cross-exchange basis.

`GET /v1/premium` re-derives this from the archived per-source candles + paired stable rates and serves it as an OHLC-of-offset series per venue (see [REST API](#premium-endpoints)). Background: `research/methods/12_premium_offset_as_publishable_index` and `chit/articles/01_bitfinex_premium`.

---

## Multi-currency

- `currencies` is the control plane — one row per asset, with `enabled` (collect this chain), `premiumEnabled` (apply the offset correction), `flatFillEmpty` (thin-token empty-minute handling), an optional per-currency `minSources` override, and an `inceptionTs` backfill floor.
- `currency_sources` maps each `(currency, venue)` to its symbol and tracks whether the venue lists that pair (`available`, auto-probed) and whether the operator wants it (`enabled`). The effective live fetch set is `available AND enabled`, minus any venue in the global formula kill-switch.
- The **Feeds** tab manages all of the above. The collector composes BTC under its own deadline first, then the remaining enabled currencies, so alts never delay BTC.
- All consumer endpoints take an optional `?currency=` (default `BTC`).

---

## Self-repair

### Source dropout

A dropout is not a gap — the row exists but `sourceCount` fell below baseline. When `sourceCount < sourceCountBaseline` for 3+ consecutive candles, the collector warns and (if configured) fires a `source_degraded` webhook; recovery fires `source_recovered`.

### Source auto-suspend

If a venue accumulates more than `sourceAutoSuspendThreshold` (default 10) guard rejections or fetch failures in a rolling 24h window, it's auto-suspended (excluded from collection), fires a `source_paused` webhook, and writes a `stream_events` row. Re-enable from the Connections/Feeds tab. Per-venue outbound rate-gating (`venueGate`) keeps concurrent same-venue requests across currencies under each venue's limit.

### Gaps & healing

Gaps are missing `candles_1m` rows, detected via `generate_series` against the expected minute sequence on startup (7-day scan), hourly (1-day scan), and on demand (`POST /monitor/heal`). Contiguous missing minutes are grouped and fetched from the enabled venues in 300-minute tiles via `healRange`, running the same guards, peg wave, and `buildComposite` as the live collector — so a healed row is full-quality. Healing also writes the paired stable-rate rows, so a stable-rate hole is repairable (not just an unfillable `unresolvable`). States: `detected → healing → healed | unresolvable`; healed gaps are kept as history. If more than 100 gaps are pending (fresh DB), healing defers to backfill.

`POST /monitor/repair` (ensureSourceCoverage → backfillStableRates → recomposeRange) rebuilds composites over a window from the source archive and reconciles the `gaps` table.

### Backfill

On first start, if less than ~90 days of data exist, backfill walks day-by-day from the inception floor, calling `healRange(..., overwrite=false)` (`insertCandleIfMissing`, never clobbers live data). Idempotent per currency via a `backfillComplete:<code>` latch; subsequent boots skip it. Runs 30s after start (to avoid hammering venues on a mass restart) and concurrently with the live collector.

### Manual scripts

```bash
npx tsx scripts/healGaps.ts [days] [--dry-run]   # force-heal blocks the 100-gap guard defers; prints a post-heal confidence histogram
npx tsx scripts/reconcileGaps.ts [days]          # flip stale terminal gap rows to healed where the minute now has data
npx tsx scripts/synchronizeWithRemoteDb.ts       # idempotent pull of candles + sources + rates from a remote candleserv DB
```

`healGaps.ts` is the escape hatch when `/monitor/gaps` shows a large block stuck `detected` (a multi-hour outage exceeds the 100-gap guard and backfill only runs once). It does not touch `backfillComplete`, so it's safe to re-run.

### Webhook alerting

If `alertWebhookUrl` is set, the system POSTs `gap_detected`, `source_degraded`, `source_recovered`, and `source_paused` alerts, with repeat-suppression so one gap doesn't fire repeatedly across scans.

---

## REST API

### Authentication

`/v1/*` routes require a per-request nonce-signed token in the `Authorization` header (the header value **is** the token — no `Bearer` prefix). `/health` is unauthenticated.

```javascript
const nonce = Date.now();                                  // must strictly increase per key (replay protection)
const chop  = SHA256(secret + ':' + nonce).hex.slice(0, 19);
const token = base64(api_key + ':' + nonce + ':' + chop);  // → Authorization: <token>
```

A Postman collection that signs requests for you (pre-request script) ships in `docs/api/` and is served live at **`/api-docs/candleserv.postman_collection.json`**. The monitor's **API** tab is a static reference for the whole surface.

### Candle endpoints

```
GET  /v1/candles?tf=<tf>&endingAt=<iso>&limit=<n>[&currency=BTC][&waitForFresh=true&maxWaitMs=<ms>]
GET  /v1/candles/latest?tf=<tf>&n=<count>[&currency=BTC]
POST /v1/candles/multi      body: { requests: [ { tf, endingAt, limit, currency? }, … ] }   # ≤16, all-or-nothing
GET  /v1/candles/subscriptions
GET  /v1/candles/stream?n=<count>[&currency=BTC]   # SSE, 1m only, rolling buffer 1–200
```

Max `limit` 5000. Higher timeframes are aggregated from 1m on read. **Timeframes:** `1m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 3d, 7d, 30d` (`7d` aligns to Monday 00:00 UTC; `30d` to calendar months).

**`waitForFresh`** holds the response until the bar closing at `endingAt` is ingested (eliminates feed-lag races). Requires `endingAt` on the tf boundary; supported tfs `1m,5m,15m,30m,1h,4h,6h,1d,7d`; `maxWaitMs` default 15000, max 60000; `504` on timeout, `503` during a repair job.

Candle JSON: `{ timestamp(ms), open, high, low, close, volume, sourceCount, sourceCountBaseline, sources, confidence }` — `volume` is the normalized value.

### Premium endpoints

```
GET /v1/premium?[currency=BTC][&tf=1m][&endingAt=<iso>][&limit=200][&venue=<name>]
GET /v1/premium/venues[?currency=BTC]
```

Per-venue OHLC-of-offset bars (signed USD): `o`/`c` are the open/close-field offset at the bucket's first/last minute, `h`/`l` the widest/narrowest the basis got intraday, `n` the contributing minutes. All standard timeframes except `30d`. Rate-limited per key (sliding 60s window, threshold `rateLimitPerMinute`, default 120; `429` + `Retry-After: 60`); `503` during a repair job.

**Multi-timeframe "now".** There is no dedicated `/premium/now` — request each timeframe with `endingAt` omitted (defaults to now) and `limit=1`: `GET /v1/premium?tf=4h&limit=1`, `?tf=1h&limit=1`, … (or batch client-side). Caveats: the value is a signed-USD **offset**, not a price; the latest bar is a **live partial bucket** (still forming — not a closed candle); an offset needs **≥3 accepted venues** for the leave-one-out consensus, else that venue is absent; nothing is persisted (recomputed from raw 1m rows each call). Target consumer: daas.

### Peg endpoints

```
GET /v1/peg/now                                                          # immediate per-venue USDT→USD peg
GET /v1/peg?tf=<tf>[&endingAt=<iso>][&limit=200][&venue=<name>]          # OHLC-of-rate history
GET /v1/peg/venues                                                       # peg venues + pegSourcePair + coverage
```

Read-only surface over the per-venue local USDT→USD rate candleserv already stores (`stable_rates_1m_sources`; see [There is no canonical USDT](#there-is-no-canonical-usdt)). **USDT-only, four venues** (`binance`, `bybit`, `gate`, `bitget`) — the adapters that carry a peg. There is **no `USDC`** (never priced — it appears only as an assumed-$1 proxy leg) and **no kraken/coinbase/bitfinex/okx** (USD-native, store no peg). No `currency` param (the peg table is currency-agnostic). Rejected rows are filtered out. Auth only — **not** rate-limited (light indexed SELECTs).

- **`/v1/peg/now`** → `{ unit:"usd", USDT:{ <venue>:<rate>, … }, timestamp:<unix ms|null> }`. The immediate peg at the **last closed minute** (`MAX(timestamp)`). A venue with no row at that minute is **omitted** (fail-visible) — never backfilled with a stale value.
- **`/v1/peg`** → `{ unit:"usd", tf, USDT:{ <venue>:[{ t, o, h, l, c, n }, … ] } }`. **OHLC-of-rate** per venue (the intraday high/low drift of the peg is the signal; the consumer averages downstream). `t` is the bucket-open unix ms, `n` the contributing minutes. `tf` defaults `1h`, all standard timeframes except `30d`; `limit` default 200, max 5000, trimmed per-venue. Optional `venue` filters to one.
- **`/v1/peg/venues`** → `{ venues:[{ name, pegSourcePair, hasData, oldest, newest, count }, … ] }`. `pegSourcePair` is the ticker each venue's rate derives from (`binance`/`bitget` `USDCUSDT`, `gate` `USDC_USDT`, `bybit` `USDTUSD`); `oldest`/`newest` are unix ms.

History depth is bounded by source retention (**~180 days**, snapped to the longest-retained currency), and the endpoints promise no fixed depth: they serve whatever is retained.

### Operational endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Status, uptime, latest candle, gaps pending, latency, recent outages |
| `GET /monitor/*` | Session | Stats, sources, gaps, errors, events, feeds, candles, config (operator UI) |
| `GET /api-docs/*` | None | Postman collection + environment (public, non-secret) |

---

## Configuration

### `.env`

```
DATABASE_URL=postgres://user:pass@host:port/dbname   # written by setup wizard
DEMO_TOKEN_SECRET=<64-char random hex>                # auto-generated at setup; signs the demo page token (only used if IS_DEMO)
SETUP_COMPLETE=true                                   # gates the setup wizard
PORT=3007                                             # set before first start if needed
READONLY_MODE=true                                    # read-only replica (see below)
IS_DEMO=true                                          # public read-only demo droplet (see below); also settable via app_settings
```

### `app_settings` (managed from the Admin tab)

| Key | Default | Description |
|-----|---------|-------------|
| `minSources` | `3` | Minimum surviving sources for a composite; also the outlier-guard threshold. Per-currency override in `currencies.minSources`. |
| `alertWebhookUrl` | `""` | HTTP POST target for gap/source alerts (empty = disabled) |
| `sourceAutoSuspendThreshold` | `10` | Guard rejections / fetch failures in 24h before auto-suspend |
| `redisUrl` | `""` | Redis URL (auto-detected on `localhost:6379` if blank) |
| `rateLimitEnabled` | `false` | Demo IP rate-limit on/off |
| `rateLimitPerMinute` | `120` | Sliding-window threshold (demo reads + `/v1/premium`) |

Settings are cached (Redis, 1h TTL); Admin-tab writes invalidate immediately.

---

## Connecting downstream services

Each consumer gets its own API key from the Admin tab. The secret is shown once at issue and cannot be retrieved — revoke and reissue if lost.

```
CANDLESERV_URL=http://localhost:3007
CANDLESERV_API_KEY=<key>
CANDLESERV_SECRET=<secret>
```

Test:
```bash
CANDLESERV_URL=… CANDLESERV_API_KEY=… CANDLESERV_SECRET=… npx tsx scripts/testCaller.ts
# or
curl http://localhost:3007/health
```

---

## Caching (Redis)

Popular queries are cached; keys expire at the next boundary for the requested timeframe (a `1h` query expires at the next hour). Historical ranges that don't overlap the open candle get a 24h TTL. Redis is optional — if unavailable, all queries hit Postgres directly.

---

## Monitor UI

A browser admin interface at `/monitor`, session-authed (PBKDF2-SHA512 passwords, 7-day sessions). Tabs:

- **Candles** — real-time candlestick chart (confidence = opacity), timeframe selector, historical query, per-source overlay
- **Connections** — per-venue status cards, connection timeline, latency, live formula editor, gaps, heal/repair controls
- **Feeds** — currency control plane: enable assets, per-venue symbol/availability/enable, per-currency settings
- **Errors** — filterable error log with auto-refresh
- **Events** — venue outage timeline
- **Admin** — API key management, app settings, source management, user management (superadmin)
- **API** — static reference for the consumer API + Postman download

### Permissions

| Permission | Description |
|-----------|-------------|
| `SUPERADMIN` | Full access, single user |
| `CAN_VIEW_CANDLESERV` | Read-only access to the monitor |
| `CAN_MODIFY_CANDLESERV` | Trigger heals/repairs, manage keys, change config |

---

## Demo mode

With `IS_DEMO=true` (env or `app_settings`), the instance is a public read-only mirror: `/v1/*` is disabled wholesale (`403`), every `/monitor` GET is served without a session given a same-origin request carrying a server-injected signed page token (secret-bearing reads — config, keys, audit log — stay denied), all mutations are `403`, and reads are clamped to 200 rows. An optional per-IP rate limit (`rateLimitEnabled` + `rateLimitPerMinute`) sheds floods. Requires `DEMO_TOKEN_SECRET`.

---

## Setup wizard

On first start, candleserv serves a wizard at `/setup`; all other routes return 503 until it completes:

1. **Database connection** — host/port/db/user/password, with a test button.
2. **Admin account** — email + password (min 12 chars); receives `SUPERADMIN`.
3. **Service configuration** — minimum sources, alert webhook URL.
4. **Confirm and install** — creates tables, seeds settings + the currency control plane, hashes the password, writes `.env`.

No restart required. To reset to factory state, delete `.env` and restart.

---

## Read-only instances

Multiple read-only instances can connect to the same production database — full monitor UI and candle reads, but no writes, heals, config changes, or key management. Only the master instance runs the collector and writes.

Enforcement is two-layered: a PostgreSQL role with `SELECT` everywhere and write access only to `sessions`, plus `READONLY_MODE=true`, which suppresses all background workers (collector, healer, gap detector, maintenance) and blocks every HTTP mutation at the app layer (GET/HEAD/OPTIONS and `POST /v1/candles/multi` — a read — pass).

### Create the read-only role (once, on the production DB)

```sql
CREATE ROLE candleserv_ro LOGIN PASSWORD '<strong password>';
GRANT CONNECT ON DATABASE candleserv TO candleserv_ro;
GRANT USAGE ON SCHEMA public TO candleserv_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO candleserv_ro;
-- sessions is the one writable table (monitor login/logout + keepalive)
GRANT INSERT, UPDATE, DELETE ON TABLE sessions TO candleserv_ro;
GRANT USAGE, SELECT ON SEQUENCE sessions_id_seq TO candleserv_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO candleserv_ro;
```

> `ALTER DEFAULT PRIVILEGES` only covers tables created *after* it runs. If the schema gains tables later, re-run `GRANT SELECT ON ALL TABLES IN SCHEMA public TO candleserv_ro;` to catch up.

The `sessions` table needs `UPDATE` as well as `SELECT`/`INSERT`/`DELETE` — without it the per-request `lastSeen` refresh fails, which can issue an anonymous cookie that silently overwrites the authenticated one and produces spurious 401s.

### Configure the replica

```
DATABASE_URL=postgres://candleserv_ro:<password>@<production-host>:5432/candleserv
DEMO_TOKEN_SECRET=<64-char random hex unique to this instance>
SETUP_COMPLETE=true
READONLY_MODE=true
PORT=3007
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Start with `pm2 start npm --name candleserv-ro -- start`; the log confirms `READONLY_MODE — collector, healer, gap detector, and maintenance disabled`.

Read-only instances issue their own DB-backed session cookies (no shared signing secret) and never write candle/gap/event/settings rows; their sessions are pruned by the master's daily job.

---

## Operator CLI

```bash
npx tsx cli/index.ts          # interactive menu
npx tsx cli/ctl.ts <command>  # same actions, scriptable (localhost /internal)
```
