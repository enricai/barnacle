/**
 * Cross-origin OOPIF candidate resolver: `observe()` returns zero candidates
 * for a cross-origin OOPIF (measured against a live Talemetry wizard embed —
 * see the frame-scoped iframe bug report), even though the frame is fully
 * attached and reachable. `page.deepLocator()` is Stagehand's own
 * hop-notation resolver and is measured to both locate and actuate elements
 * inside that same OOPIF, so this module is the single seam every
 * frame-scoped flow-runner call site uses instead of `observe()`/`act()`
 * when the step is scoped to a child frame.
 */

import type { Page } from "@browserbasehq/stagehand";

import { getLogger } from "@/lib/logging";
import { buildHopSelector } from "@/scraper/frame-target";

const logger = getLogger({ name: "scraper/deep-locator-candidates" });

/**
 * One candidate element `page.deepLocator()` resolved inside a scoped frame.
 * `selector` is `xpath=`-shaped so downstream code can synthesize a
 * `resolvedAction` the same way `deep-submit-locator` and `structured-click`
 * already do — `DeepLocatorDelegate` never hands back the concrete XPath it
 * matched, so the selector re-expresses the hop scope plus a positional
 * `nth` predicate rather than the delegate's internal resolution.
 */
export interface DeepLocatorCandidate {
  /** Positional index into the `deepLocator(hopSelector)` result set — pass to {@link clickDeepLocatorCandidate} to act on this exact candidate. */
  index: number;
  /** `xpath=`-prefixed selector identifying this candidate for downstream `resolvedAction` synthesis. */
  selector: string;
  /** Accessible text read via the delegate's `textContent()`. */
  accessibleText: string;
}

/**
 * Composes the `xpath=`-shaped selector for candidate `index` at
 * `hopSelector`: a positional `nth` predicate over the hop scope, since
 * `DeepLocatorDelegate` exposes no way to read back the concrete XPath a
 * given index resolved to.
 */
function candidateSelector(hopSelector: string, index: number): string {
  return `xpath=${hopSelector} >> nth=${index}`;
}

/**
 * Enumerates every element `page.deepLocator()` matches inside the frame
 * scoped by `frameSelector`, ranked in delegate order. Composes the hop scope
 * via `buildHopSelector` (owned by `frame-target.ts`) rather than
 * string-concatenating `>>` itself, so hop notation stays defined in exactly
 * one place. Never throws: a `count()`/`nth()`/`textContent()` failure
 * (detached frame, navigated-away element) degrades to `[]` so a caller
 * cascading through candidate sources can move on to the next technique
 * instead of crashing the step.
 */
export async function resolveDeepLocatorCandidates(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string
): Promise<DeepLocatorCandidate[]> {
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  const delegate = page.deepLocator(hopSelector);

  const count = await delegate.count().catch((err: unknown) => {
    logger.warn(`deepLocator count() threw for ${hopSelector}: ${String(err)}`);
    return 0;
  });
  if (count === 0) return [];

  const candidates: DeepLocatorCandidate[] = [];
  for (let index = 0; index < count; index++) {
    const accessibleText = await delegate
      .nth(index)
      .textContent()
      .catch(() => "");
    candidates.push({
      index,
      selector: candidateSelector(hopSelector, index),
      accessibleText: accessibleText.trim(),
    });
  }
  return candidates;
}

/**
 * Clicks the candidate at `index` inside the frame scoped by `frameSelector`,
 * re-deriving the same hop selector `resolveDeepLocatorCandidates` used
 * rather than trusting a caller-supplied `xpath=` string, so the two stay in
 * lockstep even if a candidate's `selector` field is only ever used for
 * display/logging. `DeepLocatorDelegate.click()` resolves `Promise<void>` on
 * success and rejects on failure — it never reports success via a return
 * value — so callers must infer the outcome from whether this call throws
 * plus their own downstream DOM verification, not from a returned boolean.
 */
export async function clickDeepLocatorCandidate(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number
): Promise<void> {
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  await page.deepLocator(hopSelector).nth(index).click();
}
