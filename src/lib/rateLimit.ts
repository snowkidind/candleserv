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
 * spaced MIN_INTERVAL_MS apart rather than bursting. Venues with no entry (and
 * interval 0) are a no-op — zero added latency.
 *
 * Module-level const per project convention: tuning knobs are plain consts, not
 * env vars or DB flags.
 */
const MIN_INTERVAL_MS: Record<string, number> = {
  kraken: 1100, // ~1 req/s public limit, with margin
};

// Per-venue timestamp (ms) at which the next call may proceed.
const nextAllowedAt: Record<string, number> = {};

export async function venueGate(source: string): Promise<void> {
  const interval = MIN_INTERVAL_MS[source] ?? 0;
  if (interval <= 0) return;
  const now = Date.now();
  const start = Math.max(now, nextAllowedAt[source] ?? 0);
  nextAllowedAt[source] = start + interval; // reserve this slot for the next caller
  const wait = start - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
