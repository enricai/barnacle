/**
 * Fill/select actuation seam over `deepLocator`, paralleling
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
  buildReadBackFrameCandidateExpr,
  buildSelectFrameCandidateExpr,
  DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS,
  type FrameCandidateReadBackResult,
  type FrameCandidateWriteResult,
} from "@/scraper/deep-locator-scan";
import {
  buildHopSelector,
  type FrameTarget,
  probeAttachedFrameTarget,
} from "@/scraper/frame-target";
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
   * omitted, a single non-polling `probeAttachedFrameTarget(page,
   * frameSelector)` pass (`frame-target.ts`) is attempted internally so
   * existing call sites get the batched fast path for free. Unlike a bare
   * `resolveFrameTarget(page, frameSelector, { timeoutMs: 0 })` pass — which
   * always loses the race against genuine CDP latency — this probe carries a
   * real per-probe budget (`config.scraper.framePresenceProbeFloorMs`), so it
   * can actually land against an already-attached frame under live latency.
   * If the probe doesn't land a resolved child frame, the legacy delegate
   * path runs unchanged — the same degrade contract
   * `deep-locator-candidates.ts`'s `resolveScanFrameTarget` uses for the
   * scan/click seam. A caller that already resolved a `FrameTarget` (e.g.
   * `flow-runner.ts`'s per-step resolution) should pass it here to skip the
   * redundant internal probe.
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
 * one, else a single non-polling `probeAttachedFrameTarget(page,
 * frameSelector)` pass (`frame-target.ts`) so existing call sites — which
 * pass only a `frameSelector` string — still get the batched fast path
 * without themselves changing. Unlike a bare `resolveFrameTarget(page,
 * frameSelector, { timeoutMs: 0 })` pass, the probe carries a real per-probe
 * budget, so it can land against an already-attached frame under genuine CDP
 * latency instead of always losing a zero-budget race. Returns `null` (never
 * throws) when `frameSelector` is unset, the probe rejects (e.g. a fake
 * `Page` in a legacy-path test lacking `evaluate`/`frames`), or nothing
 * attaches within the probe's budget — each of those means "no frame seam
 * available", and the caller degrades to the legacy delegate path. Parallels
 * `deep-locator-candidates.ts`'s `resolveScanFrameTarget` exactly; duplicated
 * (not imported) so this module stays a leaf that never depends on
 * `deep-locator-candidates.ts`.
 */
async function resolveActuateFrameTarget(
  page: Page,
  frameSelector: string | null | undefined,
  timeoutOptions: DeepLocatorActuateTimeoutOptions
): Promise<FrameTarget | null> {
  if (timeoutOptions.frameTarget) return timeoutOptions.frameTarget;
  if (!frameSelector) return null;
  try {
    return await probeAttachedFrameTarget(page, frameSelector);
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
 * Re-reads the candidate's CURRENT value through a second batched
 * `frameTarget.evaluate(buildReadBackFrameCandidateExpr(...))` round-trip,
 * confirming a batched write whose inline `readBack` already agreed with
 * `expected` actually stuck. The initial write expression's `readBack` is
 * read in the SAME synchronous evaluate call as the write, so it can never
 * observe a controlled component reverting the value on a later tick (a
 * `setState` inside `onChange` that re-renders after the writing evaluate
 * already returned) — exactly the duplicate-node "phantom commit" shape the
 * bug report flags as a lead. Returns `false` (never throws) on a rejecting
 * evaluate or a non-conforming/empty payload — every one of those means "the
 * confirmation couldn't be trusted", so the caller falls back to the legacy
 * delegate's own separate `.inputValue()` read-back rather than reporting a
 * false `true`.
 */
async function confirmBatchedWriteStuck(
  frameTarget: FrameTarget,
  expression: string,
  expected: string
): Promise<boolean> {
  let result: unknown;
  try {
    result = await frameTarget.evaluate<FrameCandidateReadBackResult>(expression);
  } catch {
    return false;
  }
  if (typeof result !== "object" || result === null) return false;
  return (result as Partial<FrameCandidateReadBackResult>).value === expected;
}

/**
 * Batched fill/select fast path: one `frameTarget.evaluate(expression)`
 * round-trip replaces the legacy `nth(index).fill()`/`.selectOption()` +
 * `.inputValue()` pair. Returns `null` (never throws) when no frame seam is
 * available, the evaluate call rejects, or the resolved payload doesn't
 * conform to {@link FrameCandidateWriteResult} — every one of those degrades
 * the caller to the legacy delegate path instead of losing the write,
 * paralleling `clickCandidateBatched`'s degrade contract
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
 * Prefers the {@link actuateCandidateBatched} fast path when a frame seam is
 * available: a `written: true` result whose inline `readBack` already
 * matches `value` is confirmed with one further
 * {@link confirmBatchedWriteStuck} round-trip — a read-only re-check of the
 * SAME element's CURRENT value — before resolving `true`, so a controlled
 * component that reverts the write on a LATER tick (e.g. a `setState` inside
 * `onChange` that re-renders after the writing evaluate call already
 * returned, which its own synchronous inline `readBack` can never observe)
 * is still caught. A `reason: "not-actionable"` result (the matched element
 * has no layout box) resolves `false` immediately — no delegate write against
 * that same node could succeed either. Every other batched outcome — no
 * frame seam, a rejecting or non-conforming evaluate, `reason:
 * "out-of-range"`, a `written: true` result whose inline `readBack`
 * disagrees with `value`, or a `written: true` result whose confirmation
 * re-check disagrees — degrades to the legacy
 * `deepLocator(hop).nth(index).fill()` + `.inputValue()` pair rather than
 * trusting the batched call's verdict outright: returns `true` only when
 * that separate read-back equals `value`, and `false` — never a throw — when
 * the delegate rejects the fill/read-back or the read-back disagrees.
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

  const frameTarget = await resolveActuateFrameTarget(page, frameSelector, timeoutOptions);
  const batchedResult = frameTarget
    ? await actuateCandidateBatched(
        page,
        frameSelector,
        hopSelector,
        index,
        { ...timeoutOptions, frameTarget },
        buildFillFrameCandidateExpr(innerSelector, index, value),
        "fill"
      )
    : null;
  if (
    frameTarget &&
    batchedResult?.written &&
    batchedResult.readBack === value &&
    (await confirmBatchedWriteStuck(
      frameTarget,
      buildReadBackFrameCandidateExpr(innerSelector, index),
      value
    ))
  ) {
    return true;
  }
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
 * batched-first, index-scaled-watchdog-guarded, confirm-then-trust contract as
 * {@link fillDeepLocatorCandidate} — `selectOption()` is the legacy write,
 * and `inputValue()` (which reads a `<select>`'s selected value the same as
 * any other form control) is the legacy confirmation. Differs from
 * `fillDeepLocatorCandidate` in one respect: a batched `written: true` result
 * is confirmed against its OWN `readBack` (the matched option's value)
 * rather than against the caller's `value` — {@link buildSelectFrameCandidateExpr}
 * matches an option by value OR trimmed label, so `readBack` can legitimately
 * differ from a caller-supplied label string even on a successful write.
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

  const frameTarget = await resolveActuateFrameTarget(page, frameSelector, timeoutOptions);
  const batchedResult = frameTarget
    ? await actuateCandidateBatched(
        page,
        frameSelector,
        hopSelector,
        index,
        { ...timeoutOptions, frameTarget },
        buildSelectFrameCandidateExpr(innerSelector, index, value),
        "select"
      )
    : null;
  if (
    frameTarget &&
    batchedResult?.written &&
    (await confirmBatchedWriteStuck(
      frameTarget,
      buildReadBackFrameCandidateExpr(innerSelector, index),
      batchedResult.readBack ?? ""
    ))
  ) {
    return true;
  }
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
