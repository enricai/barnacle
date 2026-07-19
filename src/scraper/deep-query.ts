/**
 * Shadow-DOM-piercing element resolver. Every other primitive in
 * flow-runner.ts locates elements via `document.querySelectorAll` /
 * `document.evaluate`, which cannot see inside a shadow root — so a
 * submit-shaped control rendered by a web component (Angular Elements,
 * Stencil, etc.) is invisible to the engine even though it's live on the
 * page. This module composes a `page.evaluate` expression string (the
 * repo's established interpolation pattern — see `INVALID_MARKER_EL_EXPR`
 * in flow-runner.ts) that recurses through `el.shadowRoot` for OPEN roots
 * to find and click such a control. Closed roots are unreachable from page
 * script by design; the traversal treats them as a dead end rather than
 * throwing.
 */

/**
 * Text/attribute predicate for "this element is submit-shaped": a native
 * `type="submit"` control, a `<button>` with no explicit `type` inside a
 * `<form>` (the HTML default is submit), or a button-role element whose
 * visible text/aria-label contains "submit". Kept as a standalone
 * expression (not a RegExp) so it can be interpolated into a browser-
 * context `page.evaluate` string, mirroring `INVALID_MARKER_EL_EXPR`.
 */
const SUBMIT_SHAPED_EL_EXPR = `((el) => {
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  if (tag === "button" && !el.getAttribute("type") && el.closest("form")) return true;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const isButtonLike = tag === "button" || role === "button";
  if (!isButtonLike) return false;
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const text = norm(el.getAttribute("aria-label") || el.textContent || "");
  return /\\bsubmit\\b/.test(text);
})`;

/**
 * Recursive open-shadow-root walker: returns every element in `root`
 * (light DOM or a shadow root) plus, for each child with an OPEN
 * `shadowRoot`, every element inside that shadow tree, arbitrarily deep.
 * A closed shadow root (`element.shadowRoot === null` from page script's
 * perspective) is simply not descended into — it contributes no elements,
 * it does not throw.
 */
const DEEP_ELEMENTS_EXPR = `((root) => {
  const out = [];
  const walk = (node) => {
    const kids = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
    for (const el of kids) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
})`;

/**
 * Builds a self-contained `page.evaluate` expression string that locates
 * the first submit-shaped control anywhere in the document — piercing open
 * shadow roots — clicks it (setting focus, then dispatching bubbling
 * mousedown/mouseup/click events, matching the repo's controlled-state
 * click convention rather than a bare `el.click()`, see flow-runner.ts's
 * checkbox/radio primitives), and returns a structured result so the
 * caller can verify what happened without a second round-trip.
 *
 * Locate-only mode (`{ clickIfFound: false }`) is exposed for callers that
 * want to probe for a deep submit control before deciding whether to act
 * on it (e.g. to distinguish "no candidate anywhere" from "found but the
 * click cascade should try a different technique first").
 */
export function buildDeepSubmitClickExpr(options?: { clickIfFound?: boolean }): string {
  const clickIfFound = options?.clickIfFound ?? true;
  return `(() => {
    const isSubmitShaped = ${SUBMIT_SHAPED_EL_EXPR};
    const deepElements = ${DEEP_ELEMENTS_EXPR};
    const candidates = deepElements(document).filter(isSubmitShaped);
    if (candidates.length === 0) return { found: false, clicked: false };
    const el = candidates[0];
    if (!${JSON.stringify(clickIfFound)}) return { found: true, clicked: false };
    if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
    el.dispatchEvent(new Event("mousedown", { bubbles: true }));
    el.dispatchEvent(new Event("mouseup", { bubbles: true }));
    el.dispatchEvent(new Event("click", { bubbles: true }));
    return { found: true, clicked: true };
  })()`;
}

/** Structured result of {@link buildDeepSubmitClickExpr}'s `page.evaluate` call. */
export interface DeepSubmitClickResult {
  found: boolean;
  clicked: boolean;
}
