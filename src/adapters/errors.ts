/**
 * Shared adapter error types.
 *
 * Adapters throw OutOfHistoryError when an exchange responds that the
 * requested window is older than the venue's historical depth. This is
 * an expected condition for any repair window that reaches deeper than
 * the venue allows — it's not a fetch failure, just "no data here."
 *
 * Callers (ensureSourceCoverage) detect this via isOutOfHistory(), so
 * they can count + summarize instead of logging per-tile stack traces.
 */
export class OutOfHistoryError extends Error {
  readonly outOfHistory = true;
  constructor(public readonly source: string, message: string) {
    super(`${source} out of history: ${message}`);
    this.name = "OutOfHistoryError";
  }
}

export function isOutOfHistory(err: unknown): err is OutOfHistoryError {
  return typeof err === "object" && err !== null && (err as { outOfHistory?: unknown }).outOfHistory === true;
}
