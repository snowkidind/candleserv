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

/**
 * Adapters throw EmptyCandleError when the venue responded successfully but
 * returned no candle for the requested minute — i.e. no trades printed that
 * minute. This is distinct from an HTTP/timeout failure. The collector uses
 * isEmptyCandle() to decide, per the currency's flatFillEmpty flag, whether to
 * flat-fill from the previous close (thin tokens) or treat it as a real failure
 * + strike (BTC and other liquid assets, where an empty minute means a glitch).
 */
export class EmptyCandleError extends Error {
  readonly emptyCandle = true;
  constructor(public readonly source: string) {
    super(`${source}: no candle returned (empty / no trades this minute)`);
    this.name = "EmptyCandleError";
  }
}

export function isEmptyCandle(err: unknown): err is EmptyCandleError {
  return typeof err === "object" && err !== null && (err as { emptyCandle?: unknown }).emptyCandle === true;
}
