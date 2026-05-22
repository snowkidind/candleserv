/**
 * Lightweight in-memory registry of currently-running healer activities.
 * Polled by GET /monitor/healer/status to surface heal activity in the
 * operator UI. Mirror of the in-flight set — entries are added when an
 * activity starts and removed when it ends (try/finally guards).
 *
 * Activities tracked:
 *   - "runBackfill"          (90-day boot reconcile + on-demand gap-detector trigger)
 *   - "reHealLowConfidence"  (low-confidence row upgrade pass)
 *   - "gapScan"              (startup + hourly gap detect+heal)
 */

export interface HealerActivity {
  name: string;
  startedAt: string;     // ISO
  meta?: Record<string, unknown>;
}

const active = new Map<string, HealerActivity>();

export function beginActivity(name: string, meta?: Record<string, unknown>): void {
  active.set(name, { name, startedAt: new Date().toISOString(), meta });
}

export function endActivity(name: string): void {
  active.delete(name);
}

export function getHealerActivities(): HealerActivity[] {
  return [...active.values()];
}
