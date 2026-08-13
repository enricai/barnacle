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
  /**
   * Fingerprint of client-side selection state across selection-bearing
   * controls — `aria-pressed`/`aria-checked`/`aria-selected`, `data-state`
   * (excluding `open`/`closed` disclosure values), `data-selected`/
   * `data-checked`, and a selected/active/checked class-token hit on an
   * interactive element. A multi-select toggle (React state flip) moves this
   * without moving network, URL, or byte size — often a NEGATIVE byte delta
   * (an `aria-pressed="false"`→`"true"` flip shrinks the HTML), which the
   * byte-floor branch can never catch. A pure `disabled`→`enabled` gate with
   * no accompanying selection-marker change is intentionally NOT tracked.
   * Optional so pre-`selectionStateSignature` snapshots (and this module's own
   * tests) stay valid; a defined pre/post pair that differs is a real effect
   * (see {@link classifyPhantomClick}). The producer is `snapshotPage`'s
   * `DOM_SNAPSHOT_EXPR` in `flow-runner.ts`, which documents the exact shape.
   */
  selectionStateSignature?: string;
}

export interface PhantomClickAttempt {
  /** Stagehand's own verdict for the attempt — did it believe it acted? */
  actResultSuccess: boolean | null;
  pre: PhantomClickSnapshot;
  post: PhantomClickSnapshot;
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
  // A client-side selection toggle (aria-pressed/checked/selected, data-state,
  // or a selected/active/checked class) is a real effect regardless of byte
  // size — the byte floor below rejects it because the delta is trivial or
  // negative. Only credit when BOTH signatures are defined (an older snapshot
  // without the field mustn't read undefined === undefined as a change) and
  // they differ. NOT on a submit-shaped step: a submit must prove itself via
  // network/URL, and letting a stray selection flip mark it "effective" would
  // defeat the cascade's phantom-verdict-driven escalation to the deep submit
  // locator.
  const selectionStateChanged =
    !attempt.isSubmitShapedStep &&
    attempt.pre.selectionStateSignature !== undefined &&
    attempt.post.selectionStateSignature !== undefined &&
    attempt.pre.selectionStateSignature !== attempt.post.selectionStateSignature;

  const hasEffect =
    networkDelta !== 0 ||
    urlChanged ||
    selectionStateChanged ||
    bytesDelta >= TRIVIAL_DOM_DELTA_BYTES;
  return hasEffect ? "effective" : "phantom";
}
