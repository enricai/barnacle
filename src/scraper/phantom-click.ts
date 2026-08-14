/**
 * Pure phantom-click predicate. `describeAttemptEffectSignals` (flow-runner.ts)
 * renders pre/post deltas into a diagnostic string for LLM consumption; this
 * module renders the same shape of data into a decision so the cascade can
 * escalate immediately instead of repeating techniques that all no-op the
 * same way (see recon-submit-phantom-click bug report).
 */

/** Cheap snapshot of side effects — field names match flow-runner's StepSnapshot. */
export interface PhantomClickSnapshot {
  networkCount: number;
  url: string;
  /** `document.body.outerHTML.length`. */
  bodyHtmlLength: number;
}

export interface PhantomClickAttempt {
  /** Stagehand's own verdict for the attempt — did it believe it acted? */
  actResultSuccess: boolean | null;
  pre: PhantomClickSnapshot;
  post: PhantomClickSnapshot;
  /**
   * True when the resolved element's OWN committed selection state changed
   * across the click — the authoritative, element-scoped signal `verifyDomEffect`
   * computes from the pre/post per-element fingerprint baseline
   * (`StepSnapshot.selectionStateByXpath`). A design-system option/toggle (Base
   * Web `kind` flip, hashed-class swap, ARIA, native `checked`) registers here
   * with no network, no URL change, and a trivial/negative byte delta that the
   * byte-floor branch can never catch. Element-scoped, so a state change on any
   * OTHER element on the page can never lift this verdict off `phantom`.
   * Optional so callers/tests that don't supply it default to `false`.
   */
  elementStateChanged?: boolean;
  /**
   * True when the step is submit-shaped (a final/submit click). A submit must
   * show a REAL effect (network/URL) to count as effective — a mere selection-
   * state flip (e.g. the submit button toggling its own `aria-pressed`, or a
   * validation render nudging some control) must NOT lift the verdict off
   * `phantom`, because the cascade's submit-escalation to `deep-submit-locator`
   * keys on a `phantom` verdict here (see `executeStepWithHealing`). Optional
   * so non-submit callers and existing tests are unchanged; defaults to false.
   */
  isSubmitShapedStep?: boolean;
}

export type PhantomClickVerdict =
  /** Stagehand reported success but pre/post shows no observable effect — a no-op click. */
  | "phantom"
  /** Stagehand reported success and pre/post shows a real effect. */
  | "effective"
  /** Stagehand couldn't resolve a target at all (error / null) — distinct from a phantom click: nothing was clicked, vs. something was clicked that did nothing. */
  | "unresolved";

/**
 * Bytes of body-HTML growth treated as noise rather than a real DOM effect.
 * Reused from `describeAttemptEffectSignals`'s dom-grew-without-network
 * boundary (flow-runner.ts) so both signals agree on what counts as
 * "trivial" — e.g. the bug report's attempt 5 (+30B) must classify as
 * phantom, not effective.
 */
export const TRIVIAL_DOM_DELTA_BYTES = 500;

/**
 * Classifies one cascade attempt as `phantom` (Stagehand claimed success but
 * pre/post shows zero network, zero URL change, and only trivial DOM
 * growth), `unresolved` (Stagehand never resolved/executed the action), or
 * `effective` (a real, observable change occurred). The cascade uses this to
 * escalate off a phantom click immediately instead of burning all five
 * techniques on the same no-op.
 */
export function classifyPhantomClick(attempt: PhantomClickAttempt): PhantomClickVerdict {
  if (attempt.actResultSuccess !== true) return "unresolved";

  const networkDelta = attempt.post.networkCount - attempt.pre.networkCount;
  const bytesDelta = attempt.post.bodyHtmlLength - attempt.pre.bodyHtmlLength;
  const urlChanged = attempt.post.url !== attempt.pre.url;
  // The resolved element's OWN committed selection state changed across the
  // click — a design-system option/toggle (Base Web `kind` flip, hashed-class
  // swap, ARIA, native `checked`) registers here with no network, no URL, and a
  // trivial/negative byte delta the byte floor can never catch. Authoritative
  // and element-scoped (`verifyDomEffect` read it off the clicked element, not a
  // page-wide fingerprint), so an unrelated element's change can't fake it. NOT
  // on a submit-shaped step: a submit must prove itself via network/URL, or the
  // cascade's phantom-verdict-driven escalation to the deep submit locator would
  // be defeated by a stray self-toggle on the submit button.
  const elementStateChanged = !attempt.isSubmitShapedStep && attempt.elementStateChanged === true;

  const hasEffect =
    networkDelta !== 0 ||
    urlChanged ||
    elementStateChanged ||
    bytesDelta >= TRIVIAL_DOM_DELTA_BYTES;
  return hasEffect ? "effective" : "phantom";
}
