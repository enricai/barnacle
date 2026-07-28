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
 * {@link isNodeNotActionableError} is the companion predicate for Issue #2
 * (clicking an unrendered node) — both live here because a caller enumerates
 * with the first and needs the second to interpret a click failure against
 * whatever the scan already reported as `visible`.
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
 * tell apart from every other candidate. Precedence mirrors the a11y-name
 * convention `buildRankSubmitCandidatesExpr` (`submit-control.ts`) applies at
 * its `aria-label`-over-`textContent` tier, extended with the sources a form
 * control actually carries: `aria-label` → `aria-labelledby` (ids resolved
 * against `root`) → an associated `label` (`label[for=id]`, or the nearest
 * ancestor `label`) → `placeholder` → `title` → `alt` → non-empty
 * `textContent` → `value` (only for `input[type=button|submit]`, where
 * `value` IS the rendered label). `root`-relative so the generated code
 * never captures an outer `document` — the same contract
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
    const text = clean(el.textContent);
    if (text) return text;
    const tag = (el.tagName || "").toLowerCase();
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
 * the expression never captures an outer `document` reference (mirrors
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
  /** Position in `querySelectorAll(innerSelector)`'s match order — aligns with `deepLocator(hop).nth(index)`, subject to the shadow-piercing divergence documented on {@link buildScanFrameCandidatesExpr}. */
  index: number;
  /** The element's derived accessible name (see {@link buildAccessibleNameExpr}'s precedence), untrimmed at the edges the precedence chain doesn't already trim — `deep-locator-candidates.ts`'s `scanFrameCandidatesBatched` `.trim()`s it before use. */
  text: string;
  /** `false` when the element has a 0x0 layout box or a computed `display:none`/`visibility:hidden` style — never actionable via a real click. */
  visible: boolean;
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
