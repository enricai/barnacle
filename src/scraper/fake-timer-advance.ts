/**
 * Default per-tick virtual-time step {@link advanceUntilSettled} advances by
 * when a caller omits `stepMs` — matches both existing call sites'
 * `ADVANCE_STEP_MS`/1s-tick constants before this module replaced them.
 */
export const DEFAULT_ADVANCE_STEP_MS = 1_000;

/**
 * Default cap on ticks {@link advanceUntilSettled} will give up before when a
 * caller omits `maxIterations` — matches both existing call sites'
 * `MAX_ADVANCE_ITERATIONS`/300-iteration bound before this module replaced
 * them (300s of virtual time, comfortably past every watchdog this repo
 * currently pins). Only clock-advancing ticks count against it; see
 * {@link DEFAULT_MAX_IDLE_ITERATIONS}.
 */
export const DEFAULT_MAX_ADVANCE_ITERATIONS = 300;

/**
 * Default cap on consecutive zero-advance ticks (see
 * {@link AdvanceUntilSettledOptions.getTimerCount}) before
 * {@link advanceUntilSettled} gives up. Bounds the real-time cost of a
 * promise that never settles while nothing is scheduled — each such tick is
 * one real event-loop turn, so this is worth roughly a second of wall clock.
 */
export const DEFAULT_MAX_IDLE_ITERATIONS = 1_000;

/**
 * Options for {@link advanceUntilSettled}. `advanceTimersByTimeAsync` is
 * injected rather than imported from `vitest` at module scope: `src/**` is
 * compiled into `dist/` and published, `vitest` is only an optional
 * peerDependency there, and a top-level `vitest` import would make this
 * module unloadable in a consumer install that never installed it — the
 * same constraint `deep-locator-fake.ts` follows.
 */
export interface AdvanceUntilSettledOptions {
  /** A fake-timer advance function, e.g. vitest's `vi.advanceTimersByTimeAsync`. */
  readonly advanceTimersByTimeAsync: (ms: number) => Promise<unknown>;
  /**
   * Pending-fake-timer count, e.g. vitest's `vi.getTimerCount`. Supply it
   * whenever the promise under test is driven by a deep real await chain
   * (`runHealingFlow` and friends) rather than by timers alone.
   *
   * Sinon's `tickAsync` drains only a bounded number of turns per call, so
   * such a chain needs many ticks purely to get its awaits to run — and
   * blindly advancing `stepMs` on each of those charges the virtual clock for
   * work that never waited on a timer. Worse, how many turns a chain needs
   * varies with real machine speed, which makes any `Date.now()`-based
   * elapsed-time assertion downstream flaky. With this supplied, ticks taken
   * while nothing is scheduled advance by 0ms — still yielding a real
   * event-loop turn, since `tickAsync(0)` does — so virtual elapsed time
   * reflects only the delays the code under test actually scheduled.
   */
  readonly getTimerCount?: () => number;
  /** Virtual milliseconds advanced per clock-advancing tick. Defaults to {@link DEFAULT_ADVANCE_STEP_MS}. */
  readonly stepMs?: number;
  /** Maximum clock-advancing ticks before giving up. Defaults to {@link DEFAULT_MAX_ADVANCE_ITERATIONS}. */
  readonly maxIterations?: number;
  /** Maximum consecutive zero-advance ticks before giving up. Defaults to {@link DEFAULT_MAX_IDLE_ITERATIONS}. */
  readonly maxIdleIterations?: number;
}

/** Result of {@link advanceUntilSettled}: whether `promise` settled before the tick budget ran out. */
export interface AdvanceUntilSettledResult {
  readonly settled: boolean;
}

/**
 * Advances a fake clock in bounded increments until `promise` settles
 * (resolves or rejects), stopping on the tick after settlement rather than
 * running a fixed number of ticks — over-advancing past settlement would
 * inflate any `Date.now()`-based elapsed-time measurement a caller takes
 * immediately after, since a fake clock has no notion of "idle" and just
 * keeps advancing however far it's told to. Also stops at `maxIterations`
 * (or `maxIdleIterations`) so a promise that never settles (e.g. a genuinely
 * wedged call under test) can't loop forever, reporting `settled: false` in
 * that case instead of throwing.
 */
export async function advanceUntilSettled(
  promise: Promise<unknown>,
  options: AdvanceUntilSettledOptions
): Promise<AdvanceUntilSettledResult> {
  const stepMs = options.stepMs ?? DEFAULT_ADVANCE_STEP_MS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ADVANCE_ITERATIONS;
  const maxIdleIterations = options.maxIdleIterations ?? DEFAULT_MAX_IDLE_ITERATIONS;
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  let advanced = 0;
  let idle = 0;
  while (!settled && advanced < maxIterations && idle < maxIdleIterations) {
    const nothingScheduled = options.getTimerCount?.() === 0;
    if (nothingScheduled) {
      idle += 1;
    } else {
      advanced += 1;
      idle = 0;
    }
    await options.advanceTimersByTimeAsync(nothingScheduled ? 0 : stepMs);
  }
  return { settled };
}
