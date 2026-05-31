# candleserv API — Postman

Postman collection + environment for the candleserv consumer API.

## Files

| File | Purpose |
|---|---|
| `candleserv.postman_collection.json` | The collection — Health + all `/v1` endpoints, with descriptions and the nonce-auth pre-request script. |
| `candleserv.postman_environment.json` | Environment template — fill `apiKey` / `apiSecret`, point `baseUrl` at your instance. |

## Setup

1. **Import** both files into Postman (*Import* → drop both).
2. Select the **candleserv (local)** environment.
3. Set `apiKey` and `apiSecret` to a key pair minted in the monitor admin UI. Leave `lastNonce` at `0`.
4. Adjust `baseUrl` if not running on the local default (`http://localhost:3007`).

> Keep `apiSecret` out of source control — the environment ships with it blank, and `lastNonce` is bookkeeping the pre-request script maintains.

## Authentication

`/health` is open. Every `/v1/*` route needs a per-request signed token in the `Authorization` header (the header value **is** the token — no `Bearer` prefix):

```
token = base64( apiKey + ":" + nonce + ":" + chop )
chop  = SHA256( apiSecret + ":" + nonce ).hex.slice(0, 19)
```

The collection's pre-request script builds this automatically for any request whose path starts with `/v1`, using `CryptoJS` (built into the Postman sandbox).

**Nonce monotonicity:** the server rejects any `nonce <= lastNonceSeen` for the key (`401 Nonce replay rejected`). The script uses `Date.now()` and stores the last value in `lastNonce` so two sends in the same millisecond still advance. If you ever get a replay error after editing the key, reset `lastNonce` to `0`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Unauth. Liveness, freshness, latency, recent outages. |
| GET | `/v1/candles/latest` | Last `n` candles of a tf, ending now. |
| GET | `/v1/candles` | `limit` candles ending at `endingAt`. Optional `waitForFresh` long-poll. |
| POST | `/v1/candles/multi` | Batched multi-tf read, ≤16 entries, all-or-nothing. |
| GET | `/v1/candles/subscriptions` | Whether this key has an open SSE stream. |
| GET | `/v1/candles/stream` | SSE, 1m only, rolling last-`n` push. |
| GET | `/v1/premium` | Per-venue premium-offset OHLC history (signed USD). |
| GET | `/v1/premium/venues` | Venue coverage + USD-native/peg flags. |

### Timeframes

`1m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 3d, 7d, 30d` — `/v1/premium` supports all except `30d`.

### Composite candle shape

```jsonc
{
  "timestamp": 1748649600000,  // bar open, unix ms
  "open": 77012.3, "high": 77140.0, "low": 76980.1, "close": 77098.7,
  "volume": 123.45,            // normalized (raw × baseline/sourceCount)
  "sourceCount": 7,
  "sourceCountBaseline": 7,
  "sources": 223,              // bitmask OR of contributing venues
  "confidence": 1.0            // [0,1] = sourceRatio × (1 − rejectedRatio)
}
```

**Source bitmask:** binance=1, bybit=2, kraken=4, coinbase=8, bitfinex=16, okx=32, gate=64, bitget=128.

### Premium bar shape (`/v1/premium`)

```jsonc
{
  "t": 1748649600000,  // bucket open, unix ms
  "o": 122.39,         // open-field offset at the bucket's first minute (signed USD)
  "h": 167.48,         // widest the basis got in the bucket
  "l": 57.07,          // narrowest
  "c": 137.48,         // close-field offset at the bucket's last minute
  "n": 60              // contributing minutes
}
```

The premium offset is the per-venue, peg-adjusted, leave-one-out deviation from the cross-venue consensus — the signal documented in `research/methods/12_premium_offset_as_publishable_index` and the bitfinex-premium article (`chit/articles/01_bitfinex_premium`). Bitfinex is the headline venue.

## Notes

- `/v1/premium` is rate-limited (per-key sliding 60s window, threshold = `rateLimitPerMinute`, default 120; `429` + `Retry-After: 60` on breach).
- Candle reads and `/v1/premium` return `503 repair in progress` while a recompose/repair job runs.
- In **demo mode**, `/v1/*` is disabled wholesale (`403 API disabled in demo mode`); the demo serves the monitor page, not the API.
