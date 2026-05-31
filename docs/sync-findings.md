# candleserv — sync integrity findings & fix list

Post multi-currency migration (Phase 12.2, `7a0e214`/`54cfd84`). All timestamps **UTC, 2026**.
DB inspected at ~2026-05-31 16:40Z. Dev machine — bad ranges below are **kept on purpose as test fixtures** for the sync/heal/repair pipeline.

The through-line: the stablecoin-aware composite now **requires a paired `stable_rates_1m_sources` row for every USDT venue** (`compose.ts:113`, `missing_paired_rate`). Any minute where a USDT candle exists but its peg rate doesn't → all USDT venues dropped → `< minSources` → composite skipped / gap `unresolvable`. The plain healer can't fix this (it never writes rate rows); only `POST /monitor/repair` (ensureSourceCoverage → backfillStableRates → recomposeRange) can.

---

## Migration structure — clean

- PKs composite: `candles_1m (currency,timestamp)`, `candles_1m_sources (currency,timestamp,source)`, gaps composite-unique.
- 7,425,300 candles preserved, all `currency='BTC'`, `backfillComplete:BTC` set, BTC `inceptionTs` correct. No data loss.

---

## Bad data ranges (test fixtures)

### 1. Pre-feature stable-rate void — *expected, but a recompose landmine*
| Range | Mins | Note |
|-------|------|------|
| `04-18 00:01` → `05-15 11:47` | ~39,587 | Stable rates began ~`05-15 08:01`. All USDT candles before that have **no paired rate**. Existing composites are fine; **re-healing/recomposing any of this window will degrade it** until `backfillStableRates` is run first. |

### 2. Stable-rate outage windows — USDT candle exists, rate missing (repair-fills-rates fixtures)
| Range | Mins |
|-------|------|
| `05-22 10:30` → `05-23 07:19` | 1,250 |
| `05-23 18:50` → `05-24 23:59` | 1,750 |
| `05-25 00:01` → `05-25 10:20` | 620 |
| `05-25 14:44` → `05-28 17:45` | 4,502 |
| `05-29 18:56` → `05-30 07:20` | 745 |
| `05-30 08:02` → `05-30 08:36` | 35 |
| Recurring singles `05-15`→`05-22`, every 5h at `:47` (e.g. `05-16 02:47`, `07:47`, `12:47`…) | 1 each |

### 3. True composite gaps still open — no candle at all
| Range | Mins | Note |
|-------|------|------|
| `05-24 00:00`, `05-26 00:00`, `05-27 00:00`, `05-28 00:00`, `05-30 00:00` | 1 each | **Recurring midnight-boundary gap** (see Bug #4) |
| `05-30 08:02` → `05-30 08:36` | ~25 (scattered) | Overlaps the stable-rate outage above — outage *caused* these gaps |

### 4. Repaired reference — recent hole (already fixed)
| Range | State |
|-------|-------|
| `05-31 13:32` → `05-31 13:46` | Composites now exist (conf **0.595**, 5 sources incl. recovered bybit). Rates backfilled. **Gap records still stale — see Bug #3.** |

### 5. Stale gap records — data good, record wrong
| Minute(s) | Composite | gaps.state |
|-----------|-----------|-----------|
| `05-18 17:07` | conf 1.0 | `unresolvable` (predates migration) |
| `05-31 13:33`–`13:46` | conf 0.595 | `unresolvable` |

### 6. Venues — enabled set (8) ≠ working set (6)
| Venue | Bit | Status |
|-------|-----|--------|
| okx | 5 | **0 rows ever** — adapter/symbol broken, never collected |
| bybit | 1 | Live-collection outage ~`05-25 12:00` → ~`05-31` (recovered/backfilled). `fetchRange` works — repair pulled it; live path was the failure. |
| binance, bitfinex, bitget, coinbase, gate, kraken | 0,4,7,3,6,2 | Working. `kraken`+`coinbase` chronically outlier-rejected → see Bug #2. |

---

## Fix list

### Bug #1 — Heal path cannot repair stable-rate holes  ·  ✅ FIXED
`healRange` (`healer.ts`) re-fetched candles but **never wrote `stable_rates_1m_sources`**, so a minute in a stable-rate outage (§2) was permanently `unresolvable` via the healer / `POST /monitor/heal` — `composeMinute` dropped every USDT venue as `missing_paired_rate`. Only `POST /monitor/repair` could fix it.
**Fixed:** both heal paths now run a peg wave and write the paired rate rows before composing.
- `healRange` (overwrite=true only): per-tile `pegFetcherRange` wave → `pegByMinute`; rate rows written before `composeMinute`. Backfill (overwrite=false) deliberately unchanged.
- `healMinute`: per-minute `pegFetcher` wave → rate rows before `composeMinute`.
- Verified: `2026-05-30 08:13Z` (was `unresolvable`, 0 rate rows, no composite) → after heal the USDT venue's rate is written and it's included in a real composite.

### Bug #2 — Outlier guard runs in raw mixed-quote space (pre-peg)  ·  ✅ FIXED
`applyGuards` compared raw `close` to the raw median; the USDT venues dominated the median, so the USD-native venues (kraken, coinbase) were rejected as `outlier` whenever the USDT premium exceeded σ. Peg normalization that makes them comparable only happens **later** in `buildComposite`. Result: chronic ~0.6 confidence even on healthy minutes (7d: only ~3,359/10,000 at 1.0).
**Fixed:** `applyGuards` takes an optional `pegRates` map and runs the outlier comparison on **peg-normalized** closes (USDT × rate; USD-native identity) — same USD basis as `historicalSigma` and the composite. Wired in at all 3 call sites (collector, `healRange`, `healMinute`). Absent map → raw comparison (unchanged for backfill / cold start).
- Verified (unit): with a $120 USD/USDT basis and σ=$60, the raw guard rejects kraken+coinbase as outliers; the normalized guard accepts all six.

### Bug #3 — `recomposeRange` doesn't reconcile the `gaps` table  ·  ✅ FIXED
Repair wrote good composites but left gap rows `unresolvable` (terminal — gap detector never rescans them). `/monitor/gaps` misreported (§5).
**Fixed (passive reconcile):** new `reconcileHealedGaps(currency, from, to)` in `db/gaps.ts` flips any `detected`/`healing`/`unresolvable` gap whose minute now has a `candles_1m` row → `healed`. Hooked at the end of `recomposeRange` (every repair self-reconciles) and in `runGapScan` (hourly 1d window + startup 7d) so stale terminal rows self-heal once their minute is filled. Only flips rows whose minute already has data — never resurrects a still-empty gap.
- `scripts/reconcileGaps.ts [days]` — one-shot wide sweep for strays older than the scan windows.
- Verified: one-time sweep flipped **16** stale rows (`05-18 17:07` + the repaired `13:33–13:46`); remaining `unresolvable` are only the genuinely-empty `05-26/27/28 00:00` midnight gaps (Bug #4).

### Bug #4 — Recurring single-minute gap at 00:00 UTC  ·  ✅ FIXED
Missing composite at exactly `00:00` on 05-24/26/27/28/30. **Root cause (same as #5):** range adapters disagree on `endTime` inclusivity — binance/bybit/bitget **include** the `endTime` minute and so drop the **bottom** of a `[tileStart, tileEnd)` window; gate/bitfinex/coinbase include the bottom. Confirmed by curl (binance/bybit `endTime=T` returns the candle *at* T). The dropped minute is always the global `from` of a `healRange`/`backfillDay` call — i.e. the day-start `00:00`. So those minutes fell below `minSources` (only the bottom-including venues present) and never composed.
**Fixed (adapter-agnostic, caller-side):** `healRange` now fetches `limit + 1` and filters each tile to the half-open `[tileStart, tileEnd)` — every minute lands in exactly one tile regardless of venue inclusivity, and the bottom is always covered. Also kills any latent boundary double-count.
- Verified: `2026-05-27 00:00` went from no composite / 3 venues → **conf 1.000, 6 venues** (binance/bitget/bybit recovered). `healGaps.ts 10` then filled all remaining day-boundary minutes (05-24/26/28/30 00:00) — **0 true missing minutes in 45d**.

### Bug #5 — Recurring stable-rate hole every 5h at :47  ·  ✅ FIXED
Single rate-row missing every 5 hours at `MM:47` — **same `endTime` off-by-one as #4**, but in `stableRateBackfill`'s 300-minute tiling: each tile boundary (every 300 min = 5h) lost its first minute's rate for binance/bybit/bitget (the inclusive-endTime venues); gate kept it. The `:47` offset is just where the tile boundaries fell relative to the backfill anchor.
**Fixed:** `stableRateBackfill` fetches `limit + 1`; its existing `[tileStartMs, tileEnd)` filter + idempotent upsert trim the overlap. (Same fix exercised by the #4 heal, which wrote binance/bitget/bybit rates at the boundary minute it previously dropped.)

### Bug #6 — enabled ≠ working: okx geo-banned, bybit rate-limited  ·  CONFIG (not a code bug)
Migration enabled all 8 BTC venues, but two never settle:
- **okx is geo-banned in Thailand** — `www.okx.com` fails DNS from this box, so it never returns data and never will here. Not a broken adapter.
- **bybit is rate-limit-sensitive** — its "gaps" are transient 429s, not an outage; it self-recovers. Not a dead venue.

**Action:** disable okx for this deployment (`currency_sources.available/enabled = false` for okx/BTC) so it stops contributing fetch failures + auto-suspend churn and `enabled` reflects reality. Leave bybit enabled; if its dropouts are frequent, widen its venue rate-gate interval rather than disabling. Working set is 6 venues (binance, bitfinex, bitget, coinbase, gate, kraken) → `sourceCountBaseline=6`.

### Bug #7 — `gaps` table misses some true gaps  ·  ✅ FIXED
Some genuinely-missing minutes (05-24 00:00, 05-30 00:00) had **no gap row at all** — `generate_series` truth diverged from the `gaps` table. **Root cause:** `clearDetectedGaps` (run after every backfill) blanket-deleted *all* `detected` rows, including minutes the backfill couldn't fill — erasing the record of a still-missing minute, which then aged out of the scan window with no path back to detection.
**Fixed:** `clearDetectedGaps` is now composite-aware — it only deletes a `detected` row whose minute actually has a `candles_1m` row. Still-missing minutes keep their record, and the post-backfill `runGapScan` re-heals them.
- Verified: was 3 missing-minutes-without-a-gap-row (2 real + the live edge) → after the heal sweep, **0 true missing minutes, 0 unresolvable** across 45d.

---

## Suggested cleanups (data, not code)
1. ~~Reconcile gaps table~~ — done; now automatic via Bug #3 fix.
2. ~~Repair remaining stable-rate holes + true gaps~~ — done: `healGaps.ts 10` + `reconcileGaps.ts` brought the DB to **0 true missing minutes / 0 unresolvable** in 45d. (Historical pre-`05-15` rows are still raw-quote — recompose-on-demand if needed; not a gap.)
