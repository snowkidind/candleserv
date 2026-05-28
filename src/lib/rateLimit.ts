/**
 * Per-venue API rate gate.
 *
 * A venue's rate limit is per-IP and shared across everything we do — the live
 * collector now fires one call per enabled currency simultaneously each minute,
 * and that overlaps with backfill/repair tiles and the probe. Most venues
 * tolerate that burst, but kraken's public API is tight (~1 req/s per IP), so a
 * 3-currency live burst plus a backfill tile trips "EGeneral:Too many requests".
 *
 * `venueGate(source)` enforces a minimum interval between successive calls to a
 * venue across ALL call paths (it's wrapped around every adapter fetch in the
 * registry). Concurrent callers each reserve the next slot, so they end up
 * spaced apart rather than bursting. Interval 0 (no default, no override) is a
 * no-op — zero added latency.
 *
 * The interval is operator-tunable per deploy via the app_settings key
 * `rateLimit.<venue>` (ms), since rate limits are deploy-specific (IP, API tier,
 * host region). The built-in const is the fallback default when unset.
 */
import { getSettingInt } from "../db/appSettings.js";

export const RATE_LIMIT_DEFAULTS: Record<string, number> = {
  kraken: 1100, // ~1 req/s public limit, with margin
};

// Per-venue timestamp (ms) at which the next call may proceed.
const nextAllowedAt: Record<string, number> = {};

export async function venueGate(source: string): Promise<void> {
  // app_settings override (cached 1h, invalidated on save) → const default → 0.
  const interval = await getSettingInt(`rateLimit.${source}`, RATE_LIMIT_DEFAULTS[source] ?? 0);
  if (interval <= 0) return;
  // read+reserve is synchronous after the await, so concurrent callers can't
  // race the slot — each advances nextAllowedAt atomically.
  const now = Date.now();
  const start = Math.max(now, nextAllowedAt[source] ?? 0);
  nextAllowedAt[source] = start + interval;
  const wait = start - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
