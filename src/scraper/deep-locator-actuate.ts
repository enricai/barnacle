/**
 * Fill/select actuation seam over `deepLocator`, mirroring
 * `clickDeepLocatorCandidate`'s contract (`deep-locator-candidates.ts`) for
 * the two other primitives a cross-origin OOPIF form's text/select steps
 * need. Stagehand `act`/`observe` are measured blind inside that OOPIF, and
 * `verifyDomEffect` (`flow-runner.ts`) can't locate a `deeplocator=` selector
 * to confirm the write, so both actuators here read the written value back
 * through the same delegate before reporting success — the caller gets a
 * trustworthy boolean instead of a downstream verifier that can never fire.
 *
 * Both actuators prefer one batched `frameTarget.evaluate(buildFillFrameCandidateExpr(...) |
 * buildSelectFrameCandidateExpr(...))` round-trip (`deep-locator-scan.ts`) over
 * the legacy `deepLocator(hop).nth(index).fill()`/`.selectOption()` +
 * `.inputValue()` pair, which pays Stagehand's `index + 1` serial
 * `resolveAtIndex` round-trips per call — the same cost
 * `clickDeepLocatorCandidate` already batches away. The legacy fallback's
 * watchdog budget scales with `index` using
 * {@link DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS} — the same per-round-trip
 * constant `clickDeepLocatorCandidate` uses — so a legitimately-reachable
 * candidate deep in a dense OOPIF form isn't killed by a budget sized for one
 * round-trip.
 */

import type { Page } from "@browserbasehq/stagehand";

import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  buildFillFrameCandidateExpr,
  buildSelectFrameCandidateExpr,
  DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS,
  type FrameCandidateWriteResult,
} from "@/scraper/deep-locator-scan";
import { buildHopSelector, type FrameTarget, resolveFrameTarget } from "@/scraper/frame-target";
import { WatchdogTimeoutError, withWatchdog } from "@/scraper/watchdog";

const logger = getLogger({ name: "scraper/deep-locator-actuate" });

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
  /**
   * Pre-resolved `FrameTarget` to actuate via one batched
   * `evaluate(buildFillFrameCandidateExpr(...) | buildSelectFrameCandidateExpr(...))`
   * round-trip instead of the legacy `nth(index)` delegate pair. When
   * omitted, a single non-polling `resolveFrameTarget(page, frameSelector,
   * { timeoutMs: 0 })` pass is attempted internally so existing call sites
   * get the batched fast path for free; if that pass doesn't land a resolved
   * child frame, the legacy delegate path runs unchanged — the same degrade
   * contract `deep-locator-candidates.ts`'s `resolveScanFrameTarget` uses for
   * the scan/click seam. A caller that already resolved a `FrameTarget`
   * (e.g. `flow-runner.ts`'s per-step resolution) should pass it here to
   * skip the redundant internal resolution pass.
   */
  frameTarget?: FrameTarget;
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
 * Resolves the `FrameTarget` a batched actuation evaluate should run
 * against: `timeoutOptions.frameTarget` when the caller already resolved
 * one, else a single non-polling `resolveFrameTarget` pass (`timeoutMs: 0`)
 * so existing call sites — which pass only a `frameSelector` string — still
 * get the batched fast path without themselves changing. Returns `null`
 * (never throws) when `frameSelector` is unset, resolution rejects (e.g. a
 * fake `Page` in a legacy-path test lacking `evaluate`/`frames`), or the
 * pass lands on the main-frame fallback rather than an attached child frame
 * — each of those means "no frame seam available", and the caller degrades
 * to the legacy delegate path. Mirrors `deep-locator-candidates.ts`'s
 * `resolveScanFrameTarget` exactly; duplicated (not imported) so this module
 * stays a leaf that never depends on `deep-locator-candidates.ts`.
 */
async function resolveActuateFrameTarget(
  page: Page,
  frameSelector: string | null | undefined,
  timeoutOptions: DeepLocatorActuateTimeoutOptions
): Promise<FrameTarget | null> {
  if (timeoutOptions.frameTarget) return timeoutOptions.frameTarget;
  if (!frameSelector) return null;
  try {
    const resolved = await resolveFrameTarget(page, frameSelector, { timeoutMs: 0 });
    return resolved?.frame ? resolved : null;
  } catch {
    return null;
  }
}

/** Narrows a batched fill/select evaluate result to {@link FrameCandidateWriteResult}'s shape, guarding against a non-conforming payload (the same degrade-to-legacy contract `deep-locator-candidates.ts`'s `isFrameCandidateScanResult`/`isFrameCandidateClickResult` enforce). */
function isFrameCandidateWriteResult(entry: unknown): entry is FrameCandidateWriteResult {
  if (typeof entry !== "object" || entry === null) return false;
  const result = entry as Partial<FrameCandidateWriteResult>;
  if (typeof result.written !== "boolean") return false;
  if (result.written) return typeof result.readBack === "string";
  return result.reason === "out-of-range" || result.reason === "not-actionable";
}

/**
 * Batched fill/select fast path: one `frameTarget.evaluate(expression)`
 * round-trip replaces the legacy `nth(index).fill()`/`.selectOption()` +
 * `.inputValue()` pair. Returns `null` (never throws) when no frame seam is
 * available, the evaluate call rejects, or the resolved payload doesn't
 * conform to {@link FrameCandidateWriteResult} — every one of those degrades
 * the caller to the legacy delegate path instead of losing the write,
 * mirroring `clickCandidateBatched`'s degrade contract
 * (`deep-locator-candidates.ts`).
 */
async function actuateCandidateBatched(
  page: Page,
  frameSelector: string | null | undefined,
  hopSelector: string,
  index: number,
  timeoutOptions: DeepLocatorActuateTimeoutOptions,
  expression: string,
  actionLabel: "fill" | "select"
): Promise<FrameCandidateWriteResult | null> {
  const frameTarget = await resolveActuateFrameTarget(page, frameSelector, timeoutOptions);
  if (!frameTarget) return null;

  let result: unknown;
  try {
    result = await frameTarget.evaluate<FrameCandidateWriteResult>(expression);
  } catch (err) {
    logger.warn(
      `deepLocator batched ${actionLabel} for ${hopSelector} nth=${index} failed, degrading to delegate ${actionLabel}: ${toErrorMessage(err)}`
    );
    return null;
  }
  if (!isFrameCandidateWriteResult(result)) {
    logger.warn(
      `deepLocator batched ${actionLabel} for ${hopSelector} nth=${index} returned a non-conforming payload, degrading to delegate ${actionLabel}`
    );
    return null;
  }
  return result;
}

/**
 * Fills the candidate at `index` inside the frame scoped by `frameSelector`
 * with `value`, re-deriving the same hop selector
 * `resolveDeepLocatorCandidates` used (`deep-locator-candidates.ts`) rather
 * than trusting a candidate's display `selector` (`deeplocator=`-prefixed,
 * deliberately not an xpath).
 *
 * Prefers the one-round-trip {@link actuateCandidateBatched} fast path when a
 * frame seam is available: a `written: true` result whose inline `readBack`
 * already matches `value` resolves `true` immediately (no second round-trip
 * needed); a `reason: "not-actionable"` result (the matched element has no
 * layout box) resolves `false` immediately — no delegate write against that
 * same node could succeed either. Every other batched outcome — no frame
 * seam, a rejecting or non-conforming evaluate, `reason: "out-of-range"`, or
 * a `written: true` result whose inline `readBack` disagrees with `value`
 * (e.g. a controlled component's `onChange` reverted the write on a tick the
 * single synchronous evaluate call couldn't observe) — degrades to the
 * legacy `deepLocator(hop).nth(index).fill()` + `.inputValue()` pair rather
 * than trusting the batched call's verdict outright: returns `true` only
 * when that separate read-back equals `value`, and `false` — never a throw —
 * when the delegate rejects the fill/read-back or the read-back disagrees.
 * The legacy path's watchdog budget scales with `index`
 * ({@link DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS}, the same per-round-trip
 * cost `clickDeepLocatorCandidate`'s legacy fallback charges), so a candidate
 * deep in a dense OOPIF form isn't killed by a budget sized for a single
 * round-trip. A wedged `fill()`/`inputValue()` call that still exceeds that
 * scaled budget rejects with a `WatchdogTimeoutError` instead of hanging the
 * caller, the same "rejects on a genuine hang" contract
 * `clickDeepLocatorCandidate` uses.
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

  const batchedResult = await actuateCandidateBatched(
    page,
    frameSelector,
    hopSelector,
    index,
    timeoutOptions,
    buildFillFrameCandidateExpr(innerSelector, index, value),
    "fill"
  );
  if (batchedResult?.written && batchedResult.readBack === value) return true;
  if (batchedResult?.reason === "not-actionable") return false;

  const scaledCallTimeoutMs = callTimeoutMs + index * DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS;
  return writeAndVerify(
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).fill(value), {
        timeoutMs: scaledCallTimeoutMs,
        label: `deepLocator fill() for ${hopSelector} nth=${index}`,
      }),
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).inputValue(), {
        timeoutMs: scaledCallTimeoutMs,
        label: `deepLocator inputValue() for ${hopSelector} nth=${index}`,
      }),
    value
  );
}

/**
 * Selects `value` on the `<select>`-shaped candidate at `index` inside the
 * frame scoped by `frameSelector`, under the same re-derived-hop,
 * batched-first, index-scaled-watchdog-guarded contract as
 * {@link fillDeepLocatorCandidate} — `selectOption()` is the legacy write,
 * and `inputValue()` (which reads a `<select>`'s selected value the same as
 * any other form control) is the legacy confirmation. Differs from
 * `fillDeepLocatorCandidate` in one respect: a batched `written: true` result
 * resolves `true` on its own, without comparing `readBack` to `value` —
 * {@link buildSelectFrameCandidateExpr} matches an option by value OR trimmed
 * label, so `readBack` (the MATCHED option's value) can legitimately differ
 * from a caller-supplied label string even on a successful write.
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

  const batchedResult = await actuateCandidateBatched(
    page,
    frameSelector,
    hopSelector,
    index,
    timeoutOptions,
    buildSelectFrameCandidateExpr(innerSelector, index, value),
    "select"
  );
  if (batchedResult?.written) return true;
  if (batchedResult?.reason === "not-actionable") return false;

  const scaledCallTimeoutMs = callTimeoutMs + index * DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS;
  return writeAndVerify(
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).selectOption(value), {
        timeoutMs: scaledCallTimeoutMs,
        label: `deepLocator selectOption() for ${hopSelector} nth=${index}`,
      }),
    () =>
      withWatchdog(() => page.deepLocator(hopSelector).nth(index).inputValue(), {
        timeoutMs: scaledCallTimeoutMs,
        label: `deepLocator inputValue() for ${hopSelector} nth=${index}`,
      }),
    value
  );
}
