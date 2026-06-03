// Inline help registry, keyed by control id (candleserv-repair-rework Stage 8 /
// Appendix A). Effect + consequence, plain English. Rendered by <InfoTip id=…>.
// "Step", never "phase" (reserved for Biasserv Phase Events).
export const HELP_TEXT: Record<string, string> = {
  // ── Repair Range ──────────────────────────────────────────────────────────
  "repair.currency":
    "The token this repair operates on. Driven by the selected Feeds tab — switch tabs to change it.",
  "repair.window":
    "Historical window to repair (UTC). Bounded by this currency's source retention; it can't include the current in-progress minute.",
  "repair.feedEnable":
    "Which venues this repair fetches and composes from — independent of the live Exchange feeds. Saving adds a dated version to this token's formula timeline, so past minutes keep composing from the venues that were selected then. Unselected venues aren't pulled at all.",
  "repair.tileSize":
    "Candles fetched per request from this venue. Larger = fewer requests = faster, but capped by the venue's API limit (coinbase 300; binance/bybit 1000).",
  "repair.throttle":
    "Seconds between tile fetches for this venue — the rate-limit guard. Lower speeds the repair but risks 429s → failed fetches → gaps. binance/bybit tolerate ~1s; leave stricter venues higher.",
  "repair.timeout":
    "How long to wait for a single fetch from this venue before giving up on it and moving on.",
  "repair.existingToken":
    "Off: only fetch token minutes with no row yet (fast, and lets a cancelled repair resume where it left off). On: re-fetch and overwrite existing rows — slower; use only to correct bad or changed data.",
  "repair.existingStable":
    "Off: only fetch peg minutes with no row yet. On: re-fetch and overwrite every peg in the window — slower. Pegs are shared across all tokens, so prefer 'Suspend REST globally' when this is on.",
  "repair.suspendGlobal":
    "Peg rates are shared across every currency, so replacing them can momentarily affect all tokens' reads. On: pause candle-read REST for ALL currencies during this repair, not just this one. (Appears only when 'Repair Existing Stable Minutes' is on.)",
  "repair.recomposeOnly":
    "Re-derive the composite from source already in the archive — no exchange fetches. Fast, DB-only. Use to re-run with a different formula. Works only while the source is still retained (see Source retention).",
  "repair.preview":
    "Estimates the work (rows to fetch / recompose) without changing anything. Run starts the actual job.",
  "repair.cancel":
    "Stops the running job at the next tile boundary. Rows already fetched are kept; with the resume behavior, a re-run continues rather than restarting.",

  // ── Repair steps (progress panel) ─────────────────────────────────────────
  "step.fetch":
    "Step 1 — fetch each selected venue's raw candles for the window into the per-venue archive. No composite yet.",
  "step.stables":
    "Step 2 — fetch the USDT→USD peg for each USDT venue over the window (shared across tokens). Required to price USDT-quoted venues.",
  "step.recompose":
    "Step 3 — re-derive the composite price index from the archive + pegs using the formula in effect at each minute. Pure DB; no fetches.",

  // ── Feeds page (live) ─────────────────────────────────────────────────────
  "feeds.chainEnabled":
    "Turn LIVE collection on/off for this token. Off stops new candles being written; existing data is untouched.",
  "feeds.premiumOffset":
    "Corrects each venue's price for its persistent premium/discount vs the cross-venue median. Inert until a minute has ≥3 accepted venues — below that, plain pegged medians are used.",
  "feeds.minSources":
    "Minimum venues that must agree before a composite minute is written. Per-currency; blank falls back to the global default (3). Lower it for thin tokens or their minutes won't compose; raise it to demand stronger consensus.",
  "feeds.sourceRetention":
    "Days of per-venue source archive to keep for this token before pruning (default 180). The composite index is kept forever regardless. Raise it to keep deeper source available for recompose-only. Shared peg rows are kept to the LONGEST retention across all tokens.",
  "feeds.daysStored":
    "Days of source archive currently in the DB for this token (now − oldest stored minute). Compare to the retention setting to see what the next prune will drop.",
  "feeds.inception":
    "Earliest date this token is considered to have data; the gap scan and backfill never look before it. Unset = defaults to now − 90d.",
  "feeds.reprobe":
    "Re-check each venue for this token's pair and update Availability. Run after enabling a new token or if a venue's listing changed.",
  "feeds.col.availability":
    "Whether the venue currently lists this pair, per the last probe. Host-dependent (e.g. okx is geo-blocked from some hosts).",
  "feeds.col.sync":
    "Include this venue in LIVE collection for this token. Does NOT affect repairs — repairs use their own feed selection in Repair Range.",

  // ── Admin ─────────────────────────────────────────────────────────────────
  "admin.sourcePrunePaused":
    "Pause the daily source-archive prune (per-venue candles + pegs). On: keep the raw inputs around so a deep backfill can be recompose-only'd before it ages past retention — at the cost of unbounded disk growth while paused. The composite index is kept forever regardless.",
};
