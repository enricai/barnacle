/**
 * Candidate-click cascade for `deep-locator-candidates.ts`'s ranked
 * `DeepLocatorCandidate[]`: `flow-runner.ts` used to click only
 * `deepLocatorCandidates[0]` (see the bug report's Issue #2), so a top pick
 * that turned out to be unrendered — a click rejecting with the CDP `-32000
 * Node does not have a layout object` error `isNodeNotActionableError`
 * classifies — scored the whole attempt as a failed click instead of trying
 * the next-ranked candidate. {@link clickFirstActionableCandidate} walks the
 * list instead, so a not-actionable rejection or a caller-supplied deny hit
 * costs only that one candidate, not the attempt.
 *
 * Extracted out of `flow-runner.ts` so the walk is unit-testable against a
 * stub click function — no fake `Page`, no Stagehand — and so
 * `flow-runner.ts`'s own edit stays a call swap (see `bugfix-005`).
 *
 * NOT IMPLEMENTED: escalating to Stagehand's `Locator.sendClickEvent()` (a
 * layout-free actuation) as a rescue for a candidate that's genuinely never
 * going to render. The report asks for skip-and-continue, not a rescue path.
 */

import type { DeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import { isNodeNotActionableError } from "@/scraper/deep-locator-scan";

/**
 * Upper bound on how many candidates a single {@link clickFirstActionableCandidate}
 * call will actually click. Denied candidates are skipped without a click and
 * don't count against this cap — only a real `click()` invocation does — so a
 * dense post-filter list (a handful of controls, per bugfix-002's visibility
 * filter and bugfix-005's interactive scoping) still resolves in one or two
 * attempts, while a pathological list (371 candidates, the oopif-7
 * measurement) can't spend the whole step budget clicking its way through
 * every entry.
 */
export const DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP = 5;

/**
 * Attempts to click one candidate. Resolves on a successful click; rejects on
 * failure — the same "no boolean return, infer from throw" contract
 * `clickDeepLocatorCandidate` (`deep-locator-candidates.ts`) already uses, so
 * a caller can inject that function directly (partially applied over
 * `page`/`frameSelector`/`innerSelector`) without an adapter.
 */
export type ClickCandidateFn = (candidate: DeepLocatorCandidate) => Promise<void>;

/** Refuses a candidate before it's clicked — e.g. `flow-runner.ts`'s `isWizardExitAction` deny-list, injected so this module stays site-agnostic. */
export type DenyCandidatePredicate = (candidate: DeepLocatorCandidate) => boolean;

/**
 * Reads the running "N selected" counter AFTER a candidate's click resolved,
 * returning the current count or `null` when no counter is exposed. Injected so
 * this module stays site-agnostic and `Page`-free — `flow-runner.ts` supplies a
 * reader that re-snapshots the frame and parses the count via
 * `selectionCountFromSignature`. See {@link ClickCandidateCascadeOptions.readSelectionCount}.
 */
export type ReadSelectionCountFn = () => Promise<number | null>;

export interface ClickCandidateCascadeOptions {
  /** Skips a candidate without clicking it when this returns `true`. Optional — omit to click every non-not-actionable candidate in rank order. */
  denyCandidate?: DenyCandidatePredicate;
  /** Overrides {@link DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP}. */
  attemptCap?: number;
  /**
   * When supplied (alongside a numeric {@link baselineSelectionCount}), a
   * candidate whose click RESOLVED but did not raise the selection count above
   * the baseline is treated like a not-actionable rejection: the walk keeps
   * going to the next candidate instead of reporting success. This is the
   * next-best-candidate recovery for a markerless multi-select phantom (the
   * #163/#164 counter veto knows the click didn't register; this feeds that
   * back into re-resolution before a replan is spent). A `null` read means "no
   * counter exposed" and never vetoes, mirroring `isSelectionCounterStalled`'s
   * null-safety. Omit for non-selection steps — the walk then behaves exactly
   * as before.
   */
  readSelectionCount?: ReadSelectionCountFn;
  /** The pre-walk selection count; a post-click read at or below this counts as "did not register". Ignored unless {@link readSelectionCount} is set. `null` disables the check (counter-less widget). */
  baselineSelectionCount?: number | null;
}

/** Outcome of a {@link clickFirstActionableCandidate} walk. */
export interface ClickCandidateCascadeOutcome {
  /** `true` only when a candidate's click resolved (didn't reject) AND, when a selection-count check is wired, registered the selection. */
  clicked: boolean;
  /** The candidate that was clicked, or `null` when the walk exhausted the list/cap without a successful click. */
  candidate: DeepLocatorCandidate | null;
  /** Selectors of every candidate this walk actually clicked (attempted), in attempt order — denied candidates are excluded since they were never clicked. */
  triedSelectors: string[];
  /** Selectors of candidates that clicked cleanly but were rejected because the selection counter did not rise (a subset of {@link triedSelectors}). Empty unless {@link ClickCandidateCascadeOptions.readSelectionCount} vetoed at least one — lets the caller emit a "clicked but nothing registered" failure reason distinct from not-actionable. */
  counterStalledSelectors: string[];
}

/**
 * Walks `candidates` in rank order, clicking each via `click` until one
 * succeeds. A candidate refused by `denyCandidate` is skipped without being
 * clicked and doesn't count against `attemptCap`. A click rejection that
 * {@link isNodeNotActionableError} classifies as "not actionable" (unrendered
 * node) is treated as "skip this candidate, try the next"; any other
 * rejection stops the walk immediately and rethrows, so a caller doesn't
 * silently burn the remaining candidates on an error that had nothing to do
 * with actionability (a detached frame, a wedged click's
 * `WatchdogTimeoutError`). Never throws on exhaustion — an exhausted list
 * (every candidate denied or not-actionable, or the cap reached) resolves to
 * `{ clicked: false, candidate: null, triedSelectors, counterStalledSelectors }`
 * instead.
 *
 * When `readSelectionCount`/`baselineSelectionCount` are supplied, a click that
 * RESOLVED but left the selection count at or below the baseline is treated
 * like a not-actionable rejection — the walk advances to the next candidate
 * instead of reporting a phantom success. A count that rose returns immediately
 * (so a click that DID register never triggers a second click — the
 * toggle-double-click guard), and a `null` read is never a veto (counter-less
 * widget). Because the check runs after `click` already awaited its own settle,
 * a synchronously-updated counter is visible; the only residual is a genuinely-
 * registered click whose counter lags, which is the same false-negative the
 * caller's late counter veto already tolerates today — behaviour is no worse,
 * and now recovers via the next candidate.
 */
export async function clickFirstActionableCandidate(
  candidates: readonly DeepLocatorCandidate[],
  click: ClickCandidateFn,
  options: ClickCandidateCascadeOptions = {}
): Promise<ClickCandidateCascadeOutcome> {
  const attemptCap = options.attemptCap ?? DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP;
  const { readSelectionCount, baselineSelectionCount } = options;
  const checkCounter =
    readSelectionCount !== undefined &&
    baselineSelectionCount !== undefined &&
    baselineSelectionCount !== null;
  const triedSelectors: string[] = [];
  const counterStalledSelectors: string[] = [];
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= attemptCap) break;
    if (options.denyCandidate?.(candidate)) continue;

    attempts += 1;
    triedSelectors.push(candidate.selector);
    try {
      await click(candidate);
    } catch (error) {
      if (!isNodeNotActionableError(error)) throw error;
      continue;
    }

    if (checkCounter) {
      const after = await readSelectionCount();
      if (after !== null && after <= baselineSelectionCount) {
        counterStalledSelectors.push(candidate.selector);
        continue;
      }
    }
    return { clicked: true, candidate, triedSelectors, counterStalledSelectors };
  }

  return { clicked: false, candidate: null, triedSelectors, counterStalledSelectors };
}
