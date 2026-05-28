import { ADAPTER_BY_NAME, SOURCE_NAMES } from "../adapters/registry.js";
import { applyGuards } from "./composite.js";
import { composeMinute } from "./compose.js";
import { getSourceCountBaseline, getRecentCloseStddev, getTrailingVolumeLeader, get24hSourceStats, getLastSourceClose } from "../db/candles.js";
import { getEnabledCurrencies, getCurrency, type CurrencyRow } from "../db/currencies.js";
import { getActiveFeeds } from "../db/currencyFeeds.js";
import { isEmptyCandle } from "../adapters/errors.js";
import { recordError } from "../db/errors.js";
import { candleEmitter } from "./emitter.js";
import { rowToJson } from "../db/candles.js";
import { insertStreamEvent } from "../db/streamEvents.js";
import { getSettingInt, setSetting } from "../db/appSettings.js";
import {
  getCurrentFormula,
  getExchangeState,
  getFailureCount,
  insertFormulaChange,
  recordFailure,
} from "../db/formulaChanges.js";
import { withTransaction } from "../db/pool.js";
import { log, logError, logWarn } from "./log.js";
import type { SourceResult } from "../types/index.js";

const DEADLINE_MS = 15000; // 15 seconds from :00 to write

// Overlap guard
let collectionRunning = false;

// Last fine-grained fetch state per source (for the operational UI's status
// dot — "on" vs "error"). This is finer than the formula state and only
// reflects the most recent fetch attempt.
const liveFetchStates: Record<string, "on" | "error" | "unknown"> = {};
const lastFetchAt: Record<string, Date | null> = {};

// D-FLATFILL: most-recent real close per `${currency}|${source}`, used to
// flat-fill no-trade minutes for currencies with flatFillEmpty=true. `.has(key)`
// distinguishes "never checked" from "checked, no prior data" (null), so cold
// start hits the DB at most once per (currency, source).
const lastClose = new Map<string, number | null>();

async function checkAutoSuspend(source: string): Promise<void> {
  const threshold = await getSettingInt("sourceAutoSuspendThreshold", 10);
  const failures = getFailureCount(source);
  if (failures < threshold) return;

  // Already excluded? insertFormulaChange short-circuits, but skip the snapshot
  // work entirely so we don't hammer the DB on every retry.
  const current = getExchangeState(source);
  if (current?.setOrUnset === "set") return;

  // Snapshot stats before flipping. If the snapshot query fails the helper
  // returns null fields — we still record the exclusion (per plan: degraded
  // UI label rather than dropping the exclusion).
  const stats = await get24hSourceStats(source);
  const statsAtExclusion = {
    failures24h: failures,
    outlierRate24h: stats.outlierRate24h,
    usedRate24h: stats.usedRate24h,
  };

  const reason = `${failures} failures in 24h`;
  await insertFormulaChange(source, "set", "auto-suspend", reason, statsAtExclusion);
  await recordError("collector", "checkAutoSuspend", `Auto-suspended ${source}: ${reason}`);
  logWarn(`[collector] auto-suspended ${source} via formula: ${reason}`);
  // insertFormulaChange handles SSE + stream_events for the formula transition.
  // We also emit the legacy "paused" stream event so existing UI's still see
  // a state change — Phase 6 frontend rework replaces this with formula state.
  try {
    await insertStreamEvent(source, "paused");
  } catch (err) {
    logWarn(`[collector] failed to record legacy paused stream event for ${source}: ${err}`);
  }
}

function recordLiveFetchState(source: string, newState: "on" | "error"): void {
  const previous = liveFetchStates[source] ?? "unknown";
  if (previous === newState) return;
  liveFetchStates[source] = newState;
  candleEmitter.emit("source_state", {
    source,
    state: newState,
    previousState: previous,
    timestamp: Date.now(),
  });
}

/**
 * Backward-compat shim. The formula is now the single knob — "paused" maps
 * to "in the formula's excludedSources." Kept as an exported helper for
 * pre-existing code paths during the transition; Phase 6 frontend lands the
 * full rename to "excluded."
 */
export function isSourcePaused(source: string): boolean {
  return getCurrentFormula().excludedSources.includes(source);
}

/**
 * Backward-compat shim. The POST /monitor/sources/:source/resume endpoint
 * still exists during the transition; routes here to the formula mutation.
 * insertFormulaChange clears the source's 24h failure counter on 'unset' so
 * it doesn't immediately re-trip auto-suspend.
 */
export async function resumeSource(source: string): Promise<void> {
  await insertFormulaChange(source, "unset", "manual:legacy-resume", "manual resume via /sources/:source/resume");
}

/**
 * Snapshot of per-source state for the monitoring UI. The shape includes both
 * legacy `paused` (alias for `excluded`) and the new formula-aware fields
 * (excluded, excludedReason, excludedBy, excludedAt, reason,
 * lastKnownAtExclusion). The legacy aliases let the current frontend keep
 * functioning until Phase 6 lands the rework.
 */
export interface SourceStatus {
  // Live fetch metadata — meaningful when not excluded.
  fetching: boolean;
  failures24h: number;
  lastFetch: string | null;
  state: string;            // legacy "on" | "error" | "unknown" — fine-grained live fetch state.

  // Formula state.
  excluded: boolean;
  paused: boolean;          // legacy alias for `excluded`.
  excludedReason: "manual" | "auto-suspend" | null;
  excludedBy: string | null;
  excludedAt: string | null;
  reason: string | null;
  lastKnownAtExclusion: {
    failures24h: number | null;
    outlierRate24h: number | null;
    usedRate24h: number | null;
  } | null;
}

export function getSourceStatus(): Record<string, SourceStatus> {
  const excludedNames = new Set(getCurrentFormula().excludedSources);
  const result: Record<string, SourceStatus> = {};
  for (const s of SOURCE_NAMES) {
    const excluded = excludedNames.has(s);
    const change = getExchangeState(s);
    const excludedRow = excluded && change?.setOrUnset === "set" ? change : null;
    const excludedReason: SourceStatus["excludedReason"] = excludedRow
      ? excludedRow.by === "auto-suspend"
        ? "auto-suspend"
        : excludedRow.by.startsWith("manual")
          ? "manual"
          : null
      : null;
    result[s] = {
      fetching: !excluded,
      failures24h: getFailureCount(s),
      lastFetch: lastFetchAt[s]?.toISOString() ?? null,
      state: liveFetchStates[s] ?? "unknown",

      excluded,
      paused: excluded,
      excludedReason,
      excludedBy: excludedRow?.by ?? null,
      excludedAt: excludedRow?.createdAt.toISOString() ?? null,
      reason: excludedRow?.reason ?? null,
      lastKnownAtExclusion: excludedRow?.statsAtExclusion ?? null,
    };
  }
  return result;
}

/**
 * Run one collection cycle for the given minute boundary, across every enabled
 * currency.
 *
 * The peg (per-venue USDT→USD rate) is asset-independent, so it is fetched once
 * per venue and shared across every currency that sources from that venue
 * (D-FEEDS). Per-currency candles are fetched per (currency, venue) using the
 * symbol declared in currency_sources. Per-venue operational state (live dot,
 * failure count, auto-suspend) is venue-global and updated once per venue from
 * the union of its fetches this minute.
 *
 * Returns true if at least one currency composed a candle within the deadline.
 */
export async function collect(minuteTs: Date): Promise<boolean> {
  if (collectionRunning) {
    logWarn("[collector] previous run still active — skipping this trigger");
    return false;
  }
  collectionRunning = true;

  const deadline = Date.now() + DEADLINE_MS;

  try {
    const currencies = await getEnabledCurrencies();
    if (!currencies.length) {
      logWarn("[collector] no enabled currencies — nothing to collect");
      return false;
    }

    // Each currency's effective fetch set: probed-available AND enabled feeds,
    // minus the global formula kill-switch. Collect the union of peg-capable
    // venues for the shared peg wave.
    const excluded = new Set(getCurrentFormula().excludedSources);
    const activeByCurrency = new Map<string, { source: string; symbol: string }[]>();
    const metaByCurrency = new Map<string, CurrencyRow>();
    const pegVenues = new Set<string>();
    for (const currency of currencies) {
      const meta = await getCurrency(currency);
      if (meta) metaByCurrency.set(currency, meta);
      const feeds = (await getActiveFeeds(currency)).filter((f) => !excluded.has(f.source));
      activeByCurrency.set(currency, feeds);
      for (const f of feeds) {
        if (ADAPTER_BY_NAME[f.source]?.normalize.pegFetcher) pegVenues.add(f.source);
      }
    }

    // Per-venue health for this minute: a venue is "error" if any fetch it was
    // issued (peg or any currency's candle) failed, "on" otherwise.
    // Per-venue failure descriptors for this minute, each tagged with the
    // (currency, symbol) — or "peg" — that failed, so a recorded fetch:<venue>
    // error says *what* was queried (e.g. "TON (TONUSDT): No candle returned")
    // instead of a context-free "No candle returned".
    const venueErrors = new Map<string, string[]>();
    const pushVenueError = (source: string, msg: string) => {
      const list = venueErrors.get(source) ?? [];
      list.push(msg);
      venueErrors.set(source, list);
    };
    const venueTouched = new Set<string>();

    // ── Peg wave: one fetch per peg-capable venue, shared across currencies. ──
    const pegSources = [...pegVenues];
    const pegSettled = await Promise.allSettled(
      pegSources.map((s) => ADAPTER_BY_NAME[s].normalize.pegFetcher!(minuteTs)),
    );
    const pegMap = new Map<string, { rate: number; pegSourcePair: string }>();
    for (let i = 0; i < pegSources.length; i++) {
      const s = pegSources[i];
      venueTouched.add(s);
      const r = pegSettled[i];
      if (r.status === "fulfilled" && r.value != null) {
        pegMap.set(s, { rate: r.value, pegSourcePair: ADAPTER_BY_NAME[s].normalize.pegSourcePair! });
      } else if (r.status === "rejected") {
        pushVenueError(s, `peg ${ADAPTER_BY_NAME[s].normalize.pegSourcePair ?? ""}: ${String(r.reason)}`);
      }
    }

    // ── Candle wave: every (currency, venue) pair in parallel. ──
    const keys: { currency: string; source: string; symbol: string }[] = [];
    for (const currency of currencies) {
      for (const f of activeByCurrency.get(currency)!) {
        keys.push({ currency, source: f.source, symbol: f.symbol });
      }
    }
    const candleSettled = await Promise.allSettled(
      keys.map((k) => ADAPTER_BY_NAME[k.source].fetchOne(k.symbol, minuteTs)),
    );
    const resultsByCurrency = new Map<string, SourceResult[]>();
    const fetchedSources = new Set<string>();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      venueTouched.add(k.source);
      const r = candleSettled[i];
      let arr = resultsByCurrency.get(k.currency);
      if (!arr) { arr = []; resultsByCurrency.set(k.currency, arr); }
      const lcKey = `${k.currency}|${k.source}`;
      if (r.status === "fulfilled") {
        arr.push({ source: k.source, candle: r.value });
        fetchedSources.add(k.source);
        lastClose.set(lcKey, r.value.close);   // D-FLATFILL: seed/refresh carry value
      } else if (isEmptyCandle(r.reason) && metaByCurrency.get(k.currency)?.flatFillEmpty) {
        // D-FLATFILL: no trades this minute on a flat-fill (thin) token → carry
        // the previous close (vol 0), no strike. Seed lastClose from the DB once
        // on cold start. A flat-fill is outlier-guard-eligible downstream.
        if (!lastClose.has(lcKey)) {
          lastClose.set(lcKey, await getLastSourceClose(k.currency, k.source));
        }
        const prev = lastClose.get(lcKey);
        if (prev != null) {
          arr.push({ source: k.source, candle: { open: prev, high: prev, low: prev, close: prev, volume: 0 } });
        } else {
          // No prior close (brand-new listing) — omit this venue, still no strike.
          arr.push({ source: k.source, candle: null, error: "no_data" });
        }
      } else {
        // Real failure (HTTP/timeout/malformed), OR empty on a strict currency
        // (BTC + liquid: an empty minute means a glitch, not a no-trade) → strike.
        arr.push({ source: k.source, candle: null, error: String(r.reason) });
        pushVenueError(k.source, `${k.currency} (${k.symbol}): ${String(r.reason)}`);
      }
    }

    if (Date.now() > deadline) {
      logError(`[collector] deadline exceeded fetching ${minuteTs.toISOString()}`);
      await recordError("collector", "deadline", `Deadline exceeded fetching ${minuteTs.toISOString()}`);
      return false;
    }

    // ── Per-venue operational state. Auto-suspend fires only when a venue is
    // WHOLLY unreachable this minute — no candle from ANY currency and no peg —
    // i.e. the venue is actually down. A venue that returned at least one
    // response is demonstrably up, so per-pair errors (a thin or delisted
    // altcoin pair) are surfaced but must NOT suspend it for BTC and every other
    // currency. (Thin no-trade minutes don't even reach here — D-FLATFILL.) ──
    for (const source of venueTouched) {
      const errs = venueErrors.get(source);
      const reachable = fetchedSources.has(source) || pegMap.has(source);
      if (reachable) lastFetchAt[source] = new Date();
      if (errs && errs.length) {
        await recordError("collector", `fetch:${source}`, errs.join("; "));
        if (reachable) {
          // Up, but one or more pairs errored — a pair problem, not venue health.
          recordLiveFetchState(source, "on");
        } else {
          // Nothing succeeded → venue down → strike toward global auto-suspend.
          recordFailure(source);
          await checkAutoSuspend(source);
          recordLiveFetchState(source, "error");
        }
      } else {
        recordLiveFetchState(source, "on");
      }
    }

    // ── Stable rates: one row per venue this minute, shared across currencies.
    // Written for every peg venue that returned at least one candle (mirrors
    // the legacy "rate row accompanies a fetched candle" semantics). The table
    // is currency-agnostic; compose's LEFT JOIN picks it up for every currency.
    await withTransaction(async (client) => {
      for (const [source, peg] of pegMap) {
        if (!fetchedSources.has(source)) continue;
        await client.query(
          `INSERT INTO stable_rates_1m_sources
             ("timestamp","source","rate","pegSourcePair")
           VALUES ($1,$2,$3,$4)
           ON CONFLICT ("timestamp","source") DO UPDATE SET
             rate = EXCLUDED.rate,
             "pegSourcePair" = EXCLUDED."pegSourcePair",
             "updatedAt" = NOW()`,
          [minuteTs, source, peg.rate, peg.pegSourcePair],
        );
      }
    });

    // ── Per-currency: guard → write archive rows → compose → emit. ──
    let anyComposed = false;
    for (const currency of currencies) {
      const results = resultsByCurrency.get(currency);
      if (!results || !results.length) continue;

      const meta         = metaByCurrency.get(currency);
      const minSources   = meta?.minSources ?? await getSettingInt("minSources", 3);
      const baseline     = await getSourceCountBaseline(currency);
      const sigma        = await getRecentCloseStddev(currency);
      const volumeLeader = await getTrailingVolumeLeader(currency, 10);
      const guarded      = applyGuards(results, minSources, sigma);

      // Write each fetched source's archive row. usedInFormula left NULL —
      // composeMinute sets it via its bulk UPDATE. Inline the insert (do NOT
      // call upsertSourceCandle — it acquires its own pool connection and would
      // break atomicity). Rate rows already written above (shared).
      await withTransaction(async (client) => {
        for (const g of guarded) {
          if (!g.candle) continue;
          await client.query(
            `INSERT INTO candles_1m_sources
               ("currency","timestamp","source","open","high","low","close","volume","rejected","rejectedReason","usedInFormula")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT ("currency","timestamp","source") DO UPDATE SET
               open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
               volume = EXCLUDED.volume, rejected = EXCLUDED.rejected, "rejectedReason" = EXCLUDED."rejectedReason",
               "usedInFormula" = EXCLUDED."usedInFormula",
               "updatedAt" = NOW()`,
            [currency, minuteTs, g.source, g.candle.open, g.candle.high, g.candle.low, g.candle.close, g.candle.volume,
             g.rejected, g.rejectedReason ?? null, null],
          );
        }
      });

      // composeMinute reads back the archive, applies the live formula, writes
      // candles_1m + bulk-UPDATEs usedInFormula — all in one transaction. The
      // invariant (usedInFormula IS NULL ⟺ no candles_1m row) holds at commit.
      const result = await composeMinute(
        currency,
        minuteTs,
        getCurrentFormula(),
        { baseline, minSources, volumeLeader: volumeLeader ?? undefined, premiumEnabled: meta?.premiumEnabled ?? true },
      );

      if (!result.composed) {
        logError(`[collector] composeMinute skipped ${currency} ${minuteTs.toISOString()} — only ${result.contributing} sources after formula+guards (need ${minSources})`);
        continue;
      }

      const composite = result.composite!;
      const json = rowToJson({
        timestamp: minuteTs,
        open: composite.open,
        high: composite.high,
        low: composite.low,
        close: composite.close,
        volume: composite.volume,
        volumeNormalized: composite.volumeNormalized,
        sourceCount: composite.sourceCount,
        sourceCountBaseline: composite.sourceCountBaseline,
        sources: composite.sources,
        confidence: composite.confidence,
      });

      candleEmitter.emit("candle", { ...json, currency });
      log(`[collector] wrote candle ${currency} ${minuteTs.toISOString()} sources=${composite.sourceCount} confidence=${composite.confidence.toFixed(2)}`);
      anyComposed = true;
    }

    return anyComposed;
  } catch (err) {
    logError("[collector] collect failed:", err);
    await recordError("collector", "collect", String(err));
    return false;
  } finally {
    collectionRunning = false;
  }
}

/**
 * Cronjob: fires at :04 past each minute.
 */
export function startCollector(): void {
  log("[collector] starting");
  scheduleNext();
}

function scheduleNext(): void {
  const now = Date.now();
  const nextMinute = Math.ceil(now / 60000) * 60000;
  const fireAt = nextMinute + 4000; // :04 past the minute
  const delay = fireAt - now;

  setTimeout(async () => {
    // Record heartbeat so we can detect outages after power failure
    void setSetting("lastHeartbeat", new Date().toISOString()).catch(() => {});
    // The candle we want is the minute that just closed
    const minuteTs = new Date(nextMinute - 60000);
    await collect(minuteTs);
    scheduleNext();
  }, delay);
}
