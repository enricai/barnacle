/**
 * Fill/select actuation seam over `deepLocator`, mirroring
 * `clickDeepLocatorCandidate`'s contract (`deep-locator-candidates.ts`) for
 * the two other primitives a cross-origin OOPIF form's text/select steps
 * need. Stagehand `act`/`observe` are measured blind inside that OOPIF, and
 * `verifyDomEffect` (`flow-runner.ts`) can't locate a `deeplocator=` selector
 * to confirm the write, so both actuators here read the written value back
 * through the same delegate before reporting success — the caller gets a
 * trustworthy boolean instead of a downstream verifier that can never fire.
 */

import type { Page } from "@browserbasehq/stagehand";

import { buildHopSelector } from "@/scraper/frame-target";
import { WatchdogTimeoutError, withWatchdog } from "@/scraper/watchdog";

/**
 * Per-CDP-call watchdog default: bounds a single `fill()`/`selectOption()`/
 * `inputValue()` round-trip. Owned locally (not imported from
 * `deep-locator-candidates.ts` or `flow-runner.ts`) so this module stays a
 * self-contained leaf, matching how `deep-locator-candidates.ts` already
 * avoids the `flow-runner.ts` import cycle by owning its own timeout
 * constant.
 */
const DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS = 10_000;

/** Overrides for the watchdog timeout this module applies to every `deepLocator()` await; tests pass small values so cases don't burn wall-clock. */
export interface DeepLocatorActuateTimeoutOptions {
  /** Per-call watchdog timeout for `fill()`/`selectOption()`/`inputValue()`. Defaults to {@link DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
}

/**
 * Runs `write`, then `readBack`, and reports whether the read-back matches
 * `expected` — the shared write/verify shape `fillDeepLocatorCandidate` and
 * `selectDeepLocatorCandidateOption` both need, differing only in which
 * delegate method performs the write. A {@link WatchdogTimeoutError} from
 * either await (a wedged CDP round-trip) propagates so the caller can tell a
 * genuine hang apart from an ordinary failed write — everything else (the
 * delegate rejecting, or a read-back that disagrees with `expected`) resolves
 * to `false` instead of throwing.
 */
async function writeAndVerify(
  write: () => Promise<unknown>,
  readBack: () => Promise<string>,
  expected: string
): Promise<boolean> {
  try {
    await write();
  } catch (error) {
    if (error instanceof WatchdogTimeoutError) throw error;
    return false;
  }
  try {
    return (await readBack()) === expected;
  } catch (error) {
    if (error instanceof WatchdogTimeoutError) throw error;
    return false;
  }
}

/**
 * Fills the candidate at `index` inside the frame scoped by `frameSelector`
 * with `value`, re-deriving the same hop selector
 * `resolveDeepLocatorCandidates` used (`deep-locator-candidates.ts`) rather
 * than trusting a candidate's display `selector` (`deeplocator=`-prefixed,
 * deliberately not an xpath). Confirms the write by reading the value back
 * through `inputValue()` on the same delegate: returns `true` only when the
 * read-back equals `value`, and `false` — never a throw — when the delegate
 * rejects the fill/read-back or the read-back disagrees (e.g. an SPA
 * re-render normalized or wiped the typed value). A wedged `fill()`/
 * `inputValue()` call that exceeds `timeoutOptions.callTimeoutMs` rejects
 * with a `WatchdogTimeoutError` instead of hanging the caller, the same
 * "rejects on a genuine hang" contract `clickDeepLocatorCandidate` uses.
 */
export async function fillDeepLocatorCandidate(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number,
  value: string,
  timeoutOptions: DeepLocatorActuateTimeoutOptions = {}
): Promise<boolean> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  return writeAndVerify(
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).fill(value), {
        timeoutMs: callTimeoutMs,
        label: `deepLocator fill() for ${hopSelector} nth=${index}`,
      }),
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).inputValue(), {
        timeoutMs: callTimeoutMs,
        label: `deepLocator inputValue() for ${hopSelector} nth=${index}`,
      }),
    value
  );
}

/**
 * Selects `value` on the `<select>`-shaped candidate at `index` inside the
 * frame scoped by `frameSelector`, under the exact same re-derived-hop,
 * read-back-verified, watchdog-guarded contract as
 * {@link fillDeepLocatorCandidate} — `selectOption()` is the write, and
 * `inputValue()` (which reads a `<select>`'s selected value the same as any
 * other form control) is the confirmation.
 */
export async function selectDeepLocatorCandidateOption(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number,
  value: string,
  timeoutOptions: DeepLocatorActuateTimeoutOptions = {}
): Promise<boolean> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  return writeAndVerify(
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).selectOption(value), {
        timeoutMs: callTimeoutMs,
        label: `deepLocator selectOption() for ${hopSelector} nth=${index}`,
      }),
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).inputValue(), {
        timeoutMs: callTimeoutMs,
        label: `deepLocator inputValue() for ${hopSelector} nth=${index}`,
      }),
    value
  );
}
