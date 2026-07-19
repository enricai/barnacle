/**
 * Pure phantom-click predicate. `describeAttemptEffectSignals` (flow-runner.ts)
 * renders pre/post deltas into a diagnostic string for LLM consumption; this
 * module renders the same shape of data into a decision so the cascade can
 * escalate immediately instead of repeating techniques that all no-op the
 * same way (see recon-submit-phantom-click bug report).
 */

/** Cheap snapshot of side effects — field names mirror flow-runner's StepSnapshot. */
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

  const hasEffect = networkDelta !== 0 || urlChanged || bytesDelta >= TRIVIAL_DOM_DELTA_BYTES;
  return hasEffect ? "effective" : "phantom";
}
