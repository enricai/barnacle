/**
 * Default per-tick virtual-time step {@link advanceUntilSettled} advances by
 * when a caller omits `stepMs` — matches both existing call sites'
 * `ADVANCE_STEP_MS`/1s-tick constants before this module replaced them.
 */
export const DEFAULT_ADVANCE_STEP_MS = 1_000;

/**
 * Default cap on ticks {@link advanceUntilSettled} will take before giving up
 * when a caller omits `maxIterations` — matches both existing call sites'
 * `MAX_ADVANCE_ITERATIONS`/300-iteration bound before this module replaced
 * them (300s of virtual time, comfortably past every watchdog this repo
 * currently pins).
 */
export const DEFAULT_MAX_ADVANCE_ITERATIONS = 300;

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
  /** Virtual milliseconds advanced per tick. Defaults to {@link DEFAULT_ADVANCE_STEP_MS}. */
  readonly stepMs?: number;
  /** Maximum number of ticks before giving up. Defaults to {@link DEFAULT_MAX_ADVANCE_ITERATIONS}. */
  readonly maxIterations?: number;
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
 * so a promise that never settles (e.g. a genuinely wedged call under test)
 * can't loop forever, reporting `settled: false` in that case instead of
 * throwing.
 */
export async function advanceUntilSettled(
  promise: Promise<unknown>,
  options: AdvanceUntilSettledOptions
): Promise<AdvanceUntilSettledResult> {
  const stepMs = options.stepMs ?? DEFAULT_ADVANCE_STEP_MS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ADVANCE_ITERATIONS;
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < maxIterations && !settled; i++) {
    await options.advanceTimersByTimeAsync(stepMs);
  }
  return { settled };
}
