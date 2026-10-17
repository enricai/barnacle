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
  /** `<len>:<first-200-chars>` of visible text, as in flow-runner's StepSnapshot. */
  visibleTextSignature?: string;
  /** Bounded whitespace-normalised excerpt of the visible text (see flow-runner's StepSnapshot). */
  visibleText?: string;
  /** Digest of the whole normalised visible text, so a change beyond the head or excerpt is still seen. */
  visibleTextDigest?: string;
}

/** The visible-text slice of a snapshot, for callers that judge a page advance from text alone. */
export type VisibleTextState = Pick<
  PhantomClickSnapshot,
  "visibleTextSignature" | "visibleText" | "visibleTextDigest"
>;

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
   * True when a submit-shaped step is NOT the flow's final submit (e.g. an
   * account-creation transition in a wizard). Such a step is credited when
   * {@link hasPageBodySwapped} holds even with no network/URL/title signal.
   * Implies `isSubmitShapedStep`: a mid-flow submit is submit-shaped by
   * definition, so callers need not set both for it to be held to submit rules.
   */
  isMidFlowSubmitStep?: boolean;
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
 * sign-in-shaped veto. When `preUrl` is given and the origin/path did not
 * change, the page did not navigate, so no destination veto applies: a
 * mid-flow account-creation step on an unchanged sign-in URL is still judged
 * on its own evidence.
 */
export function isPlausibleStepDestination(
  stepInstruction: string,
  postUrl: string,
  preUrl?: string
): boolean {
  // A click that never left its page cannot have bounced to an auth gate; an
  // account-creation step on a sign-in URL is the page's own transition.
  if (preUrl !== undefined && !hasOriginOrPathChanged(preUrl, postUrl)) return true;
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

/** Minimum visible-text length change for a mid-flow submit to count as a page advance. */
export const PAGE_ADVANCE_MIN_TEXT_LENGTH_DELTA = 100;

/** Relative visible-text length change that also counts as an advance on a short page. */
export const PAGE_ADVANCE_MIN_TEXT_LENGTH_RATIO = 0.3;

/** Floor under the relative rule so a tooltip on a tiny page is not an advance. */
export const PAGE_ADVANCE_MIN_RELATIVE_TEXT_LENGTH_DELTA = 30;

/** Word-set similarity below which the visible-text head counts as replaced. */
export const PAGE_ADVANCE_MAX_HEAD_SIMILARITY = 0.5;

function textLengthOf(signature: string | undefined): number | null {
  if (signature === undefined) return null;
  const match = /^(\d+):/.exec(signature);
  return match ? Number(match[1]) : null;
}

function textHeadWords(signature: string): Set<string> {
  const head = signature.slice(signature.indexOf(":") + 1).toLowerCase();
  return new Set(head.split(/\W+/).filter((w) => w !== ""));
}

function headWordSimilarity(pre: string, post: string): number {
  const preWords = textHeadWords(pre);
  const postWords = textHeadWords(post);
  const union = new Set([...preWords, ...postWords]);
  if (union.size === 0) return 1;
  const shared = [...preWords].filter((w) => postWords.has(w)).length;
  return shared / union.size;
}

/** Words dropped AND introduced in the head for it to count as swapped copy. */
const PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS = 2;

function leadingHeadWord(signature: string): string | undefined {
  return signature
    .slice(signature.indexOf(":") + 1)
    .toLowerCase()
    .split(/\W+/)
    .find((w) => w !== "");
}

function isHeadSwapped(pre: string, post: string): boolean {
  const preWords = textHeadWords(pre);
  const postWords = textHeadWords(post);
  const dropped = [...preWords].filter((w) => !postWords.has(w)).length;
  if (dropped < PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS) return false;
  const added = [...postWords].filter((w) => !preWords.has(w)).length;
  if (added >= PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS) return true;
  // A swapped header can reuse a word the shared chrome already carries (a
  // "My Account" header over an "Account" button), leaving a single new word;
  // a new word leading the head still marks replaced copy.
  const leading = leadingHeadWord(post);
  return leading !== undefined && !preWords.has(leading);
}

type PageAdvanceKind = "none" | "header" | "body";

const KIND_RANK: Record<PageAdvanceKind, number> = { none: 0, header: 1, body: 2 };

/** Head length the signature keeps; the excerpt tail starts past it. */
const SIGNATURE_HEAD_CHARS = 200;

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w !== "")
  );
}

function wordSetSimilarity(preWords: Set<string>, postWords: Set<string>): number {
  const union = new Set([...preWords, ...postWords]);
  if (union.size === 0) return 1;
  return [...preWords].filter((w) => postWords.has(w)).length / union.size;
}

function swappedWordCounts(
  preWords: Set<string>,
  postWords: Set<string>
): { dropped: number; added: number } {
  return {
    dropped: [...preWords].filter((w) => !postWords.has(w)).length,
    added: [...postWords].filter((w) => !preWords.has(w)).length,
  };
}

/**
 * Reads the movement of the page's whole visible text rather than its 200-char
 * head: a wizard body that re-renders under unchanged chrome (long nav, same
 * header, same length) leaves the signature untouched, so the excerpt's words
 * decide whether the copy itself was replaced. `body` only when the replaced
 * words sit in the text past the head, so a head-only flip stays `header`.
 */
function fullTextAdvanceKind(
  pre: PhantomClickSnapshot,
  post: PhantomClickSnapshot
): PageAdvanceKind {
  const preText = pre.visibleText;
  const postText = post.visibleText;
  if (!preText || !postText || preText === postText) return "none";
  const preWords = wordsOf(preText);
  const postWords = wordsOf(postText);
  const similarity = wordSetSimilarity(preWords, postWords);
  if (similarity === 1) return "none";
  if (similarity < PAGE_ADVANCE_MAX_HEAD_SIMILARITY) return "body";
  const { dropped, added } = swappedWordCounts(
    wordsOf(preText.slice(SIGNATURE_HEAD_CHARS)),
    wordsOf(postText.slice(SIGNATURE_HEAD_CHARS))
  );
  if (
    dropped >= PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS &&
    added >= PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS
  ) {
    return "body";
  }
  const headSwap = swappedWordCounts(
    wordsOf(preText.slice(0, SIGNATURE_HEAD_CHARS)),
    wordsOf(postText.slice(0, SIGNATURE_HEAD_CHARS))
  );
  return headSwap.dropped >= PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS &&
    headSwap.added >= PAGE_ADVANCE_MIN_SWAPPED_HEAD_WORDS
    ? "header"
    : "none";
}

function signatureAdvanceKind(preSig: string, postSig: string): PageAdvanceKind {
  if (preSig === postSig) return "none";
  const preLen = textLengthOf(preSig);
  const postLen = textLengthOf(postSig);
  if (preLen === null || postLen === null) return "none";
  const lengthDelta = Math.abs(postLen - preLen);
  if (lengthDelta >= PAGE_ADVANCE_MIN_TEXT_LENGTH_DELTA) return "body";
  const similarity = headWordSimilarity(preSig, postSig);
  // Identical head words mean whitespace/layout reflow, not new copy.
  if (similarity === 1) return "none";
  if (
    lengthDelta >= PAGE_ADVANCE_MIN_RELATIVE_TEXT_LENGTH_DELTA &&
    lengthDelta / Math.max(preLen, 1) >= PAGE_ADVANCE_MIN_TEXT_LENGTH_RATIO
  ) {
    return "body";
  }
  if (similarity < PAGE_ADVANCE_MAX_HEAD_SIMILARITY) return "body";
  // Shared chrome (nav, footer) inflates similarity when a wizard swaps only
  // its header and body copy within the 200-char head.
  return isHeadSwapped(preSig, postSig) ? "header" : "none";
}

/**
 * Reports whether the visible text differs at all between two snapshots, using
 * the whole-text digest when both carry one so a change beyond the 200-char
 * signature head is not missed. Falls back to the signature alone.
 */
export function hasVisibleTextChanged(
  pre: PhantomClickSnapshot,
  post: PhantomClickSnapshot
): boolean {
  if (pre.visibleTextSignature !== post.visibleTextSignature) return true;
  return (
    !!pre.visibleTextDigest &&
    !!post.visibleTextDigest &&
    pre.visibleTextDigest !== post.visibleTextDigest
  );
}

/**
 * Reads how far the visible text moved: `body` when the copy itself was
 * replaced (a large or relative length change, or a head whose words were
 * mostly swapped, or replaced words past the head), `header` when only a
 * header-sized slice moved over shared chrome, `none` otherwise. The split lets
 * a settle tell a finished transition from a header that flipped before its
 * body re-rendered.
 */
function pageAdvanceKind(pre: PhantomClickSnapshot, post: PhantomClickSnapshot): PageAdvanceKind {
  const preSig = pre.visibleTextSignature;
  const postSig = post.visibleTextSignature;
  if (preSig === undefined || postSig === undefined) return "none";
  if (!hasVisibleTextChanged(pre, post)) return "none";
  const fromSignature = signatureAdvanceKind(preSig, postSig);
  const fromFullText = fullTextAdvanceKind(pre, post);
  return KIND_RANK[fromFullText] > KIND_RANK[fromSignature] ? fromFullText : fromSignature;
}

/**
 * Decides whether the page demonstrably advanced (a wizard step swapped
 * content) from pre/post snapshots alone, so a network-free, URL-stable
 * transition is still credited. Visible text is the evidence: a wizard swap
 * can leave the HTML size nearly unchanged (same-size markup, different
 * copy), so byte delta is deliberately not required. The text must have
 * moved substantially — a large absolute or relative length change, or a
 * head whose words were mostly replaced — so a tooltip or inline validation
 * line (small, mostly-shared text) is not an advance.
 */
export function hasPageAdvanced(pre: PhantomClickSnapshot, post: PhantomClickSnapshot): boolean {
  return pageAdvanceKind(pre, post) !== "none";
}

/**
 * Stricter sibling of {@link hasPageAdvanced} for deciding a re-render has
 * finished: a header that flipped over shared chrome is an advance, but the
 * body usually re-renders after it, so only replaced copy counts as settled.
 */
export function hasPageBodySwapped(pre: PhantomClickSnapshot, post: PhantomClickSnapshot): boolean {
  return pageAdvanceKind(pre, post) === "body";
}

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
  const midFlowSubmit = attempt.isMidFlowSubmitStep === true;
  const submitShaped = attempt.isSubmitShapedStep === true || midFlowSubmit;
  // Element-scoped selection flip; not on a submit-shaped step, which must
  // prove itself via network/URL or the deep-submit escalation is defeated.
  const elementStateChanged = !submitShaped && attempt.elementStateChanged === true;
  // A submit-shaped step likewise ignores a mere DOM-byte reflow.
  const bytesChangedSignificantly =
    !submitShaped && Math.abs(bytesDelta) >= TRIVIAL_DOM_DELTA_BYTES;

  const midFlowAdvanced = midFlowSubmit && hasPageBodySwapped(attempt.pre, attempt.post);

  const hasEffect =
    networkDelta !== 0 ||
    urlChanged ||
    elementStateChanged ||
    bytesChangedSignificantly ||
    midFlowAdvanced;
  return hasEffect ? "effective" : "phantom";
}
