/**
 * Frame-scoped candidate-scan seam: `resolveDeepLocatorCandidates`
 * (`deep-locator-candidates.ts`) pays one CDP round-trip per candidate via
 * `delegate.nth(index).textContent()`, because Stagehand 3.7.0's
 * `FrameSelectorResolver.resolveAll` re-resolves the selector from index 0
 * on every call (understudy/selectorResolver.js) — enumerating n candidates
 * costs n(n+1)/2 round-trips, not n. Through Browserbase's proxied CDP into
 * a cross-origin OOPIF, that measured out to ~4.6s per candidate — 371
 * candidates never finish inside any reasonable budget.
 *
 * {@link buildScanFrameCandidatesExpr} is the fix: one `Frame.evaluate` call
 * that reads accessible-name + layout/visibility for EVERY match of an inner
 * selector inside the frame's own document, in a single CDP round-trip. The
 * accessible name (not bare `textContent`, which the DOM spec always leaves
 * empty for `input`/`select`/`textarea`) is what lets an `INTERACTIVE_CANDIDATE_SELECTOR`
 * match like a labelled `<input>` surface something the rephrase LLM and
 * `scoreCandidate` can actually compare against a step instruction.
 * {@link buildClickFrameCandidateExpr} is the actuation half of Issue #2
 * (clicking an unrendered node): a second one-round-trip evaluate call that
 * re-runs the same `querySelectorAll(innerSelector)` resolution, clicks the
 * element at a scan-derived `index`, and reports out-of-range /
 * not-actionable outcomes as data instead of throwing a CDP `-32000` error.
 * {@link isNodeNotActionableError} is the companion predicate for the case
 * where a click is attempted through a different path (e.g. Stagehand's own
 * `deepLocator().click()`) and throws anyway — both live here because a
 * caller enumerates with the first and needs the second or third to
 * interpret a click outcome against whatever the scan already reported as
 * `visible`.
 *
 * {@link buildFillFrameCandidateExpr} and {@link buildSelectFrameCandidateExpr}
 * extend the same one-round-trip actuation seam to the two write primitives
 * `clickDeepLocatorCandidate` never needed: today
 * `fillDeepLocatorCandidate`/`selectDeepLocatorCandidateOption`
 * (`deep-locator-actuate.ts`) still pay a `deepLocator().nth(index).fill()`
 * (or `.selectOption()`) round-trip PLUS a separate `.inputValue()`
 * round-trip to confirm the write — each individually as expensive as
 * `clickDeepLocatorCandidate`'s pre-fix per-index resolve. These two
 * builders collapse write + read-back into the same evaluate call, out-of-
 * range/not-actionable reported as data exactly like the click builder.
 */

/**
 * CSS selector for the interactive-element universe the deepLocator cascade
 * should enumerate instead of `"*"`, so a candidate set that would otherwise
 * be hundreds of structural nodes (`html`, `body`, every wrapping `div`) is
 * instead a handful of clickable controls. Exported as the single definition
 * both the cascade and its tests share. Safe as the final `buildHopSelector`
 * segment — `resolveLocatorTarget` only ever splits hop notation on `">>"`
 * (understudy/deepLocator.js), so this selector's commas pass through intact.
 */
export const INTERACTIVE_CANDIDATE_SELECTOR =
  "button, a, input, select, textarea, [role=button], [tabindex]";

/**
 * Additional per-CDP-round-trip watchdog budget charged per candidate
 * `index`, on top of a call's own `callTimeoutMs`, for every legacy
 * `deepLocator(hop).nth(index)` delegate fallback — `clickDeepLocatorCandidate`
 * (`deep-locator-candidates.ts`) and `fillDeepLocatorCandidate`/
 * `selectDeepLocatorCandidateOption` (`deep-locator-actuate.ts`) alike.
 * Stagehand's `FrameSelectorResolver.resolveAtIndex(query, i)` resolves
 * `Locator.nth(i)` via `resolveAll(query, {limit: i + 1})`, whose
 * `resolveCss` loops one serial `Runtime.evaluate` round-trip per index up
 * to and including `i` (understudy/selectorResolver.js:70,79-115) before
 * ANY `.nth(i)`-chained method (`click()`, `fill()`, `selectOption()`,
 * `inputValue()`) ever dispatches — so acting at index `i` costs `i + 1`
 * round-trips, not one, and a fixed `callTimeoutMs` (which only ever
 * budgeted a single round-trip) starves any candidate past the index where
 * `(i + 1) * measuredRoundTripMs` exceeds it (measured ~0.66s/round-trip
 * through Browserbase's proxied CDP into a live cross-origin OOPIF — run-7:
 * candidate 13 enumerated within a 60s budget, i.e. 91 cumulative
 * round-trips). `callTimeoutMs` already covers the first round-trip; this
 * constant is the budget added per each of the remaining `index` round-trips,
 * rounded up from the measured cost to leave headroom for CDP jitter. Hoisted
 * here (rather than left module-private to `deep-locator-candidates.ts`) so
 * `deep-locator-actuate.ts` can reuse it without importing
 * `deep-locator-candidates.ts` or `flow-runner.ts` (import-cycle risk).
 */
export const DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS = 1_000;

/**
 * Visibility check shared by every candidate the scan expression builds: a
 * node with a 0x0 layout box, or a computed `display:none`/
 * `visibility:hidden`, can never be the target of a real click — this is the
 * DOM-observable symptom that {@link isNodeNotActionableError} catches from
 * the CDP-error side when a click is attempted anyway.
 */
const IS_VISIBLE_EXPR = `((el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
})`;

/**
 * Computes an element's accessible name so an interactive control with no
 * visible text — an `input`/`select`/`textarea`, which the DOM spec defines
 * as always having empty `textContent` — still yields something
 * `scoreCandidate` (`deep-locator-candidates.ts`) and the rephrase LLM can
 * tell apart from every other candidate. Precedence parallels the a11y-name
 * convention `buildRankSubmitCandidatesExpr` (`submit-control.ts`) applies at
 * its `aria-label`-over-`textContent` tier, extended with the sources a form
 * control actually carries: `aria-label` → `aria-labelledby` (ids resolved
 * against `root`) → an associated `label` (`label[for=id]`, or the nearest
 * ancestor `label`) → `placeholder` → `title` → `alt` → non-empty
 * `textContent` → `value` (only for `input[type=button|submit]`, where
 * `value` IS the rendered label). `<select>` skips the `textContent` tier
 * entirely — a `<select>`'s `textContent` is every `<option>`'s text
 * concatenated ("United StatesCanadaMexico…"), which can accidentally
 * substring-match an unrelated step instruction and outrank the
 * correctly-labelled field; an unlabelled `<select>` falls through to `""`
 * (the caller's `|| ""` contract) instead. `root`-relative so the generated
 * code never captures an outer `document` — the same contract
 * {@link buildScanFrameCandidatesExpr} itself honors.
 */
function buildAccessibleNameExpr(root: string): string {
  return `((el) => {
    const clean = (s) => {
      const t = (s || "").trim();
      return t.length > 0 ? t : null;
    };
    const attr = (name) => (el.getAttribute ? el.getAttribute(name) : null);
    const ariaLabel = clean(attr("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = attr("aria-labelledby");
    if (labelledBy) {
      const getById = (elId) => (${root}.getElementById ? ${root}.getElementById(elId) : null);
      const labelledText = clean(
        labelledBy
          .split(/\\s+/)
          .map((elId) => {
            const target = getById(elId);
            return target ? target.textContent : "";
          })
          .join(" ")
      );
      if (labelledText) return labelledText;
    }
    const findLabelFor = (targetId) => {
      if (!targetId || !${root}.querySelectorAll) return null;
      const labels = Array.from(${root}.querySelectorAll("label"));
      return (
        labels.find((label) => label.getAttribute && label.getAttribute("for") === targetId) ||
        null
      );
    };
    const id = attr("id");
    const associatedLabel = findLabelFor(id) || (el.closest ? el.closest("label") : null);
    const labelText = associatedLabel ? clean(associatedLabel.textContent) : null;
    if (labelText) return labelText;
    const placeholder = clean(attr("placeholder"));
    if (placeholder) return placeholder;
    const title = clean(attr("title"));
    if (title) return title;
    const alt = clean(attr("alt"));
    if (alt) return alt;
    const tag = (el.tagName || "").toLowerCase();
    if (tag !== "select") {
      const text = clean(el.textContent);
      if (text) return text;
    }
    const type = (attr("type") || "").toLowerCase();
    if (tag === "input" && (type === "button" || type === "submit")) {
      const value = clean(attr("value"));
      if (value) return value;
    }
    return "";
  })`;
}

/**
 * Builds a self-contained evaluate expression that queries `root` for every
 * match of `innerSelector` via `document.querySelectorAll` — the SAME
 * resolution Stagehand's own primary CSS resolver uses
 * (`resolveCssSelector(sel, i) = querySelectorAll(sel)[i]`, in the frame's
 * own document) — and returns one entry per match, in document order:
 * `{ index, text, visible }`. `index` therefore lines up 1:1 with the index
 * `deepLocator(hop).nth(index)` will later resolve to, so a caller can scan
 * once here and hand an index to the existing per-index click path without
 * re-deriving the candidate set.
 *
 * That alignment diverges only when the light-DOM query matches fewer than
 * `i + 1` elements, which is what triggers Stagehand's shadow-piercing
 * `resolveCssSelectorPierce` fallback instead of the plain CSS resolver —
 * `innerSelector` should stay a plain, non-shadow-crossing selector (e.g.
 * {@link INTERACTIVE_CANDIDATE_SELECTOR}) whenever a caller depends on index
 * alignment with `deepLocator`.
 *
 * `root` overrides the traversal root expression (default `"document"`),
 * interpolated verbatim into the generated code so a caller evaluating this
 * expression via `Frame.evaluate` still resolves that frame's own document —
 * the expression never captures an outer `document` reference (parallels
 * `buildRankSubmitCandidatesExpr`'s contract in `submit-control.ts`).
 */
export function buildScanFrameCandidatesExpr(innerSelector: string, root = "document"): string {
  return `(() => {
    const isVisible = ${IS_VISIBLE_EXPR};
    const accessibleName = ${buildAccessibleNameExpr(root)};
    const matches = Array.from(${root}.querySelectorAll(${JSON.stringify(innerSelector)}));
    return matches.map((el, index) => ({
      index,
      text: accessibleName(el),
      visible: isVisible(el),
    }));
  })()`;
}

/** One candidate {@link buildScanFrameCandidatesExpr}'s evaluate call returns. */
export interface FrameCandidateScanResult {
  /** Position in `querySelectorAll(innerSelector)`'s match order — aligns with `deepLocator(hop).nth(index)` and with {@link buildClickFrameCandidateExpr}'s `index` argument, subject to the shadow-piercing divergence documented on {@link buildScanFrameCandidatesExpr}. */
  index: number;
  /** The element's derived accessible name (see {@link buildAccessibleNameExpr}'s precedence), untrimmed at the edges the precedence chain doesn't already trim — `deep-locator-candidates.ts`'s `scanFrameCandidatesBatched` `.trim()`s it before use. */
  text: string;
  /** `false` when the element has a 0x0 layout box or a computed `display:none`/`visibility:hidden` style — never actionable via a real click. */
  visible: boolean;
}

/**
 * Builds a self-contained evaluate expression that re-runs the SAME
 * `root.querySelectorAll(innerSelector)` resolution {@link buildScanFrameCandidatesExpr}
 * uses and clicks the element at `index` (dispatching focus + bubbling
 * mousedown/mouseup/click, matching `buildClickByDeepIndexExpr`'s
 * (`submit-control.ts`) controlled-state click convention). This is the
 * one-round-trip actuation half of the batched-scan fix: a caller that
 * scanned via {@link buildScanFrameCandidatesExpr} can hand the chosen
 * `index` straight to this builder without re-deriving the candidate set,
 * because both builders resolve `querySelectorAll(innerSelector)` against
 * the same frame document in the same match order.
 *
 * Reports out-of-range / not-actionable outcomes as data rather than by
 * throwing, paralleling {@link isNodeNotActionableError}'s CDP-error-side
 * contract from the DOM-observable side:
 * - `index` no longer matches (e.g. the DOM changed between scan and click)
 *   returns `{ clicked: false, reason: "out-of-range" }`.
 * - the matched element fails {@link IS_VISIBLE_EXPR} — the same
 *   visibility check {@link buildScanFrameCandidatesExpr} reports as
 *   `visible: false` — returns `{ clicked: false, reason: "not-actionable" }`
 *   instead of dispatching a click a real browser would reject with a
 *   `-32000 Node does not have a layout object` CDP error.
 *
 * `root` overrides the traversal root expression (default `"document"`) and
 * must match the `root` passed to the {@link buildScanFrameCandidatesExpr}
 * call that produced `index`, or the re-run query will not resolve against
 * the same document. Interpolated verbatim so a caller evaluating this
 * expression via `Frame.evaluate` still resolves that frame's own document —
 * the expression never captures an outer `document` reference.
 */
export function buildClickFrameCandidateExpr(
  innerSelector: string,
  index: number,
  root = "document"
): string {
  return `(() => {
    const isVisible = ${IS_VISIBLE_EXPR};
    const matches = Array.from(${root}.querySelectorAll(${JSON.stringify(innerSelector)}));
    const el = matches[${JSON.stringify(index)}];
    if (!el) return { clicked: false, reason: "out-of-range" };
    if (!isVisible(el)) return { clicked: false, reason: "not-actionable" };
    if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
    el.dispatchEvent(new Event("mousedown", { bubbles: true }));
    el.dispatchEvent(new Event("mouseup", { bubbles: true }));
    el.dispatchEvent(new Event("click", { bubbles: true }));
    return { clicked: true };
  })()`;
}

/** Reason {@link buildClickFrameCandidateExpr} reports when it returns `{ clicked: false }` instead of throwing. */
export type FrameCandidateClickSkipReason = "out-of-range" | "not-actionable";

/** Result of {@link buildClickFrameCandidateExpr}'s evaluate call. */
export interface FrameCandidateClickResult {
  clicked: boolean;
  /** Present only when `clicked` is `false` — distinguishes a stale index from an unrendered element. */
  reason?: FrameCandidateClickSkipReason;
}

/** Reason {@link buildFillFrameCandidateExpr}/{@link buildSelectFrameCandidateExpr} report when they return `{ written: false }` instead of throwing — same two reasons {@link FrameCandidateClickSkipReason} reports for a click, since both re-run the identical resolve-and-check-visibility steps. */
export type FrameCandidateWriteSkipReason = "out-of-range" | "not-actionable";

/** Result of {@link buildFillFrameCandidateExpr}'s or {@link buildSelectFrameCandidateExpr}'s evaluate call. */
export interface FrameCandidateWriteResult {
  written: boolean;
  /** Present only when `written` is `true` — the value read back from the element immediately after the write, so a caller can compare it against what it asked for without a second round-trip. For the select expression this is the MATCHED option's `value`, not necessarily the (possibly label) string the caller passed in. */
  readBack?: string;
  /** Present only when `written` is `false` — distinguishes a stale index from an element the write could not land on. */
  reason?: FrameCandidateWriteSkipReason;
}

/**
 * Builds the write body {@link buildFillFrameCandidateExpr} and
 * {@link buildSelectFrameCandidateExpr} both interpolate: re-runs the SAME
 * `root.querySelectorAll(innerSelector)` resolution
 * {@link buildScanFrameCandidatesExpr}/{@link buildClickFrameCandidateExpr}
 * use, guards out-of-range/not-actionable the same way as
 * {@link buildClickFrameCandidateExpr}, then writes `value` through
 * `nativePrototypeExpr`'s `value` setter descriptor rather than a bare
 * `el.value = value` assignment — a React/Angular/Vue controlled component
 * shadows the setter at the instance level, so a bare assignment can be
 * silently absorbed by the framework's own value tracking while the DOM
 * read-back still looks correct (a silent false positive); calling the
 * descriptor's setter explicitly restores native behavior, paralleling
 * `fillHtml5DateTimeInput`'s and `applySelectValue`'s identical workaround in
 * `flow-runner.ts`. Falls back to a bare assignment when no such descriptor
 * exists (a plain, unmanaged form control). Dispatches bubbling `input` then
 * `change` then `blur` — the sequence a controlled component's `onChange`/
 * `onBlur` listen for — before reading `el.value` back into the returned
 * payload, so the caller gets write + verify in one round-trip instead of a
 * second `inputValue()` call.
 *
 * `nativePrototypeExpr` is interpolated verbatim as a JS expression
 * evaluated inside the generated code (with `el` in scope) rather than
 * passed as a resolved value, so {@link buildFillFrameCandidateExpr} can
 * choose between `HTMLInputElement`/`HTMLTextAreaElement` based on the
 * resolved element's own tag at evaluate-time.
 */
function buildWriteFrameCandidateExpr(
  innerSelector: string,
  index: number,
  value: string,
  nativePrototypeExpr: string,
  root: string
): string {
  return `(() => {
    const isVisible = ${IS_VISIBLE_EXPR};
    const matches = Array.from(${root}.querySelectorAll(${JSON.stringify(innerSelector)}));
    const el = matches[${JSON.stringify(index)}];
    if (!el) return { written: false, reason: "out-of-range" };
    if (!isVisible(el)) return { written: false, reason: "not-actionable" };
    const value = ${JSON.stringify(value)};
    const descriptor = Object.getOwnPropertyDescriptor(${nativePrototypeExpr}, "value");
    if (descriptor && descriptor.set) { descriptor.set.call(el, value); } else { el.value = value; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return { written: true, readBack: el.value };
  })()`;
}

/**
 * Builds a self-contained evaluate expression that fills the `<input>`/
 * `<textarea>` at `root.querySelectorAll(innerSelector)[index]` with
 * `value` — the one-round-trip write half of
 * {@link fillDeepLocatorCandidate}'s (`deep-locator-actuate.ts`) contract.
 * See {@link buildWriteFrameCandidateExpr} for the shared write/dispatch/
 * read-back mechanism and out-of-range/not-actionable reporting. Resolves
 * the native value-setter descriptor off `HTMLTextAreaElement.prototype`
 * when the matched element's own `tagName` is `"textarea"`, else
 * `HTMLInputElement.prototype` — determined at evaluate-time (inside the
 * generated code), since `innerSelector` may match a mix of input and
 * textarea nodes (e.g. {@link INTERACTIVE_CANDIDATE_SELECTOR}).
 *
 * `root` overrides the traversal root expression (default `"document"`) and
 * must match the `root` a prior {@link buildScanFrameCandidatesExpr} call
 * used to derive `index`, paralleling
 * {@link buildClickFrameCandidateExpr}'s `root` contract.
 */
export function buildFillFrameCandidateExpr(
  innerSelector: string,
  index: number,
  value: string,
  root = "document"
): string {
  const nativePrototypeExpr =
    '(el.tagName && el.tagName.toLowerCase() === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype)';
  return buildWriteFrameCandidateExpr(innerSelector, index, value, nativePrototypeExpr, root);
}

/**
 * Builds a self-contained evaluate expression that re-runs the SAME
 * `root.querySelectorAll(innerSelector)` resolution and selects, on the
 * `<select>`-shaped candidate at `index`, the option whose `value` — or,
 * failing that, whose trimmed visible label — matches `value`. Matching by
 * value first matches what a `<select>`'s own `value` property actually is
 * (the matched option's `value` attribute); falling back to the trimmed
 * label covers a flow instruction that quotes the option's VISIBLE label
 * instead (`parseSelectStep`), which a `<select>`'s DOM `value` never is —
 * the same value-then-label tolerance `trySelectPrimitive`'s deterministic
 * match already applies across every `<select>` on the page
 * (`flow-runner.ts:3576`), reproduced here inline because this expression
 * matches options within one already-chosen candidate rather than
 * enumerating the whole page. See {@link buildWriteFrameCandidateExpr} for
 * the write/dispatch/read-back mechanism this reimplements to accommodate
 * the option lookup — the shared helper alone can't express "write the
 * MATCHED option's value, not the caller's raw string."
 *
 * `root` overrides the traversal root expression (default `"document"`) and
 * must match the `root` a prior {@link buildScanFrameCandidatesExpr} call
 * used to derive `index`, paralleling
 * {@link buildClickFrameCandidateExpr}'s `root` contract. A candidate with
 * no option matching `value` by either value or label reports
 * `{ written: false, reason: "not-actionable" }` — nothing on the page can
 * satisfy the write.
 */
export function buildSelectFrameCandidateExpr(
  innerSelector: string,
  index: number,
  value: string,
  root = "document"
): string {
  return `(() => {
    const isVisible = ${IS_VISIBLE_EXPR};
    const matches = Array.from(${root}.querySelectorAll(${JSON.stringify(innerSelector)}));
    const el = matches[${JSON.stringify(index)}];
    if (!el) return { written: false, reason: "out-of-range" };
    if (!isVisible(el)) return { written: false, reason: "not-actionable" };
    const wanted = ${JSON.stringify(value)};
    const wantedTrimmed = wanted.trim();
    const options = Array.from(el.options || []);
    const target =
      options.find((o) => o.value === wanted) ||
      options.find((o) => (o.textContent || "").trim() === wantedTrimmed);
    if (!target) return { written: false, reason: "not-actionable" };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (descriptor && descriptor.set) { descriptor.set.call(el, target.value); } else { el.value = target.value; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return { written: true, readBack: el.value };
  })()`;
}

/** Result of {@link buildReadBackFrameCandidateExpr}'s evaluate call. */
export interface FrameCandidateReadBackResult {
  /** `undefined` when the index is out of range or the element has no layout box — the caller can't distinguish those from a genuine revert, so it degrades to the legacy delegate path exactly as it would for any other non-conforming batched outcome. */
  value?: string;
}

/**
 * Builds a read-only re-check expression: re-runs the SAME
 * `root.querySelectorAll(innerSelector)` resolution as
 * {@link buildWriteFrameCandidateExpr} and returns the element's CURRENT
 * `.value`, without writing anything. {@link fillDeepLocatorCandidate}/
 * {@link selectDeepLocatorCandidateOption} (`deep-locator-actuate.ts`) call
 * this in a second `evaluate` round-trip, after the initial batched write's
 * inline `readBack` already agreed with the caller's value, to catch a
 * controlled component that reverts the write on a later tick (e.g. a
 * `setState` inside `onChange` that re-renders after the writing evaluate
 * call already returned) — a revert the write expression's own synchronous
 * inline read-back can never observe, since it reads `el.value` in the same
 * task as the write.
 */
export function buildReadBackFrameCandidateExpr(
  innerSelector: string,
  index: number,
  root = "document"
): string {
  return `(() => {
    const isVisible = ${IS_VISIBLE_EXPR};
    const matches = Array.from(${root}.querySelectorAll(${JSON.stringify(innerSelector)}));
    const el = matches[${JSON.stringify(index)}];
    if (!el) return {};
    if (!isVisible(el)) return {};
    return { value: el.value };
  })()`;
}

/**
 * Detects the CDP "node is not actionable" failure shape so a caller
 * cascading through candidates can treat it as "skip this candidate, try the
 * next" instead of scoring the attempt as a failed click. Covers both
 * surfaces a click against an unrendered node can throw through: a raw CDP
 * protocol error rejects as `new Error(`${code} ${message}`)`
 * (understudy/cdp.js), so a `DOM.getBoxModel`/`DOM.scrollIntoViewIfNeeded`
 * failure over "no layout object" arrives as a plain `Error` whose message is
 * exactly `-32000 Node does not have a layout object`; separately,
 * `Locator.click()`/`Locator.hover()` (understudy/locator.js) throw
 * `ElementNotVisibleError` directly when `DOM.getBoxModel` returns no model.
 * A name/substring check on both shapes is sufficient — no new error class
 * is needed.
 */
export function isNodeNotActionableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ElementNotVisibleError") return true;
  return /node does not have a layout object/i.test(error.message);
}
