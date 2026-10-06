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
   * with no network, no URL change, and a byte delta whose magnitude stays
   * below the byte-floor branch's threshold. Element-scoped, so a state change on any
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
  /**
   * Mirrors flow-runner's own `isPlausibleStepDestination` gate on its
   * `urlChanged`/`retryUrlChanged` signals: false when the post-URL landed
   * on a destination (e.g. a sign-in gate) that doesn't plausibly
   * corroborate the step's own instruction. Required so no caller can
   * silently fail open; it vetoes every effect signal, not only the URL ones.
   */
  destinationPlausible: boolean;
}

function originAndPathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Credits a navigation as real only when origin or pathname actually
 * changed, so a same-page query-string mutation (e.g. a step counter) never
 * counts as an advance. Shared by {@link classifyPhantomClick} and
 * flow-runner's own urlChanged/retryUrlChanged checks so both agree on what
 * counts as a genuine navigation.
 */
export function hasOriginOrPathChanged(preUrl: string, postUrl: string): boolean {
  return originAndPathOf(preUrl) !== originAndPathOf(postUrl);
}

/** Word-boundary phrase patterns identifying a sign-in/log-in step. */
export const SIGN_IN_PATTERNS = [/\bsign[\s-]?in\b/, /\blog[\s-]?in\b/];

/** Collapses whitespace and lowercases, so instruction text compares consistently against {@link SIGN_IN_PATTERNS}. */
function normalizeForPatternMatch(instruction: string): string {
  return instruction.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Closed list of recognized step-instruction imperative verbs, mirroring the
 * closed-list style of recon-browser.ts's ACCOUNT_CREATION_PATTERNS/
 * SUBMIT_SHAPED_INSTRUCTION_PATTERNS, used to isolate a step instruction's
 * own action clause(s) from surrounding descriptive context.
 */
const STEP_ACTION_VERBS = [
  "click",
  "tap",
  "press",
  "select",
  "choose",
  "check",
  "uncheck",
  "toggle",
  "fill",
  "type",
  "enter",
  "input",
  "upload",
  "attach",
  "drag",
  "drop",
  "scroll",
  "submit",
  "switch",
  "navigate",
  "open",
  "expand",
  "collapse",
  "confirm",
  "agree",
  "accept",
  "continue",
];

const STEP_ACTION_VERB_PATTERN = new RegExp(`\\b(?:${STEP_ACTION_VERBS.join("|")})\\b`);

/**
 * Verbs whose own direct complement is introduced by "to" (e.g. "navigate to
 * the sign in page"), so splitting on " to " must NOT sever them from that
 * complement the way it severs e.g. "click sign in to continue" into
 * independent clauses — doing so would strand the verb's own target text
 * (which is where a sign-in-shaped match actually lives) in a clause with no
 * recognized action verb, and {@link splitIntoActionClauses} would then
 * discard it as non-action descriptive context.
 */
const TO_COMPLEMENT_VERBS = ["navigate", "go", "switch", "scroll", "open", "proceed"];

/**
 * Splits a step instruction into its comma/"to"/"and"-delimited clauses and
 * keeps only the ones containing a recognized imperative action verb, so
 * pattern matching (e.g. {@link SIGN_IN_PATTERNS}) targets the step's own
 * action rather than descriptive context that merely mentions a page element.
 * Falls back to every clause when none carry a recognized verb, preserving
 * today's conservative whole-text behavior for unparseable instruction shapes
 * rather than silently passing. Exported so other sign-in-shaped-instruction
 * checks (e.g. bugfix-002) can reuse the same clause isolation. Does not split
 * on " to " when it directly follows a {@link TO_COMPLEMENT_VERBS} verb, so
 * "navigate to the sign in page" stays one clause instead of stranding "the
 * sign in page" apart from its governing verb.
 */
export function splitIntoActionClauses(instruction: string): string[] {
  const normalized = normalizeForPatternMatch(instruction);
  const toComplementPattern = new RegExp(`\\b(?:${TO_COMPLEMENT_VERBS.join("|")}) to `);
  const toPlaceholder = "__BARNACLE_TO__";
  const protectedText = normalized.replace(toComplementPattern, (match) =>
    match.replace(" to ", ` ${toPlaceholder} `)
  );
  const clauses = protectedText
    .split(/,| (?:to|and) /)
    .map((clause) => clause.trim().replace(toPlaceholder, "to"))
    .filter((clause) => clause.length > 0);
  const actionClauses = clauses.filter((clause) => STEP_ACTION_VERB_PATTERN.test(clause));
  return actionClauses.length > 0 ? actionClauses : clauses;
}

/**
 * Gates whether a landed destination plausibly corroborates a step's own
 * instruction, so a URL change alone is never enough to credit advancement:
 * if the destination is sign-in-shaped but the step itself wasn't about
 * signing in, the page bounced back to an auth gate rather than advancing.
 * Matches {@link SIGN_IN_PATTERNS} only against the instruction's own
 * action clause(s) (see {@link splitIntoActionClauses}), so a step whose
 * surrounding descriptive text merely mentions a sign-in form isn't
 * mistaken for a step that is itself about signing in. Fails open (returns
 * true) on an unparseable postUrl, matching {@link hasOriginOrPathChanged}'s
 * own try/catch style, since an unparseable URL gives no basis for a
 * sign-in-shaped veto.
 */
export function isPlausibleStepDestination(stepInstruction: string, postUrl: string): boolean {
  const pathname = (() => {
    try {
      return new URL(postUrl).pathname;
    } catch {
      return null;
    }
  })();
  if (pathname === null) return true;
  const landedOnSignIn = SIGN_IN_PATTERNS.some((p) => p.test(pathname.toLowerCase()));
  if (!landedOnSignIn) return true;
  const actionClauses = splitIntoActionClauses(stepInstruction);
  return actionClauses.some((clause) => SIGN_IN_PATTERNS.some((p) => p.test(clause)));
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
  if (!attempt.destinationPlausible) return "phantom";

  const urlChanged = hasOriginOrPathChanged(attempt.pre.url, attempt.post.url);
  // Element-scoped selection flip; not on a submit-shaped step, which must
  // prove itself via network/URL or the deep-submit escalation is defeated.
  const elementStateChanged = !attempt.isSubmitShapedStep && attempt.elementStateChanged === true;
  // A submit-shaped step likewise ignores a mere DOM-byte reflow.
  const bytesChangedSignificantly =
    !attempt.isSubmitShapedStep && Math.abs(bytesDelta) >= TRIVIAL_DOM_DELTA_BYTES;

  const hasEffect =
    networkDelta !== 0 || urlChanged || elementStateChanged || bytesChangedSignificantly;
  return hasEffect ? "effective" : "phantom";
}
