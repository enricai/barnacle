/**
 * Single timeout primitive for bounding a browser/CDP await that can hang
 * indefinitely (deepLocator calls, frame resolution, any Stagehand-adjacent
 * promise that isn't already covered by Stagehand's own `timeout` option).
 * Every hand-rolled `Promise.race` against a CDP call should route through
 * `withWatchdog` instead, so a stuck call fails the attempt and lets the
 * self-healing cascade proceed rather than pinning the run forever.
 */

/**
 * Thrown by {@link withWatchdog} when the wrapped operation does not settle
 * within `timeoutMs`. Deliberately NOT part of the `ScraperError` hierarchy
 * in `@/scraper/errors` — this module stays a dependency-free leaf so every
 * downstream fix (deepLocator, frame resolution, Stagehand guards) can adopt
 * it without risking an import cycle back through the classified-failure
 * taxonomy.
 */
export class WatchdogTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "WatchdogTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** Tuning knobs for {@link withWatchdog}. */
export interface WatchdogOptions {
  /** Milliseconds to wait before rejecting with {@link WatchdogTimeoutError}. */
  timeoutMs: number;
  /** Human-readable name for the guarded operation, echoed in the timeout error message. */
  label: string;
}

/**
 * Races a thunked operation against a timer so a never-settling promise
 * (a hung CDP call is the motivating case) turns into a rejection instead of
 * blocking the caller forever. The operation is accepted as a thunk rather
 * than a bare promise so it's constructed only once the race has started,
 * matching how every other guarded call site in the scraper already shapes
 * its `Promise.race`.
 */
export async function withWatchdog<T>(
  op: () => Promise<T>,
  options: WatchdogOptions
): Promise<T> {
  const { timeoutMs, label } = options;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WatchdogTimeoutError(label, timeoutMs)), timeoutMs);
  });
  timer?.unref();
  try {
    return await Promise.race([op(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
