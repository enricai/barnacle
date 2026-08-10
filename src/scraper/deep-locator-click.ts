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

export interface ClickCandidateCascadeOptions {
  /** Skips a candidate without clicking it when this returns `true`. Optional — omit to click every non-not-actionable candidate in rank order. */
  denyCandidate?: DenyCandidatePredicate;
  /** Overrides {@link DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP}. */
  attemptCap?: number;
}

/** Outcome of a {@link clickFirstActionableCandidate} walk. */
export interface ClickCandidateCascadeOutcome {
  /** `true` only when a candidate's click resolved (didn't reject). */
  clicked: boolean;
  /** The candidate that was clicked, or `null` when the walk exhausted the list/cap without a successful click. */
  candidate: DeepLocatorCandidate | null;
  /** Selectors of every candidate this walk actually clicked (attempted), in attempt order — denied candidates are excluded since they were never clicked. */
  triedSelectors: string[];
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
 * `{ clicked: false, candidate: null, triedSelectors }` instead.
 */
export async function clickFirstActionableCandidate(
  candidates: readonly DeepLocatorCandidate[],
  click: ClickCandidateFn,
  options: ClickCandidateCascadeOptions = {}
): Promise<ClickCandidateCascadeOutcome> {
  const attemptCap = options.attemptCap ?? DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP;
  const triedSelectors: string[] = [];
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= attemptCap) break;
    if (options.denyCandidate?.(candidate)) continue;

    attempts += 1;
    triedSelectors.push(candidate.selector);
    try {
      await click(candidate);
      return { clicked: true, candidate, triedSelectors };
    } catch (error) {
      if (!isNodeNotActionableError(error)) throw error;
    }
  }

  return { clicked: false, candidate: null, triedSelectors };
}
