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

import { clickActivationExpr } from "@/scraper/browser-click-expr";

/**
 * Text/attribute predicate for "this element is submit-shaped": a native
 * `type="submit"` control, a `<button>` with no explicit `type` inside a
 * `<form>` (the HTML default is submit), any element whose visible
 * text/aria-label contains "submit" or a generic action verb
 * (create/continue/next/confirm/proceed — the labels JS-handled action
 * controls with an explicit `type="button"` commonly use instead of the
 * literal word "submit") regardless of tag/role — a checkout form's
 * click-handled `<div>`/`<span>`/custom-element control carries the same
 * signal a `<button>` would — or a button-role element that is the sole
 * non-excluded actionable control inside its nearest form-like container
 * (kept tag/role-gated since it has no text signal of its own to rank on).
 * Back/Cancel/Close/Dismiss/Save draft/Save for later/Previous controls are
 * excluded from every text-based and sole-control branch — the same
 * negative list `submit-control.ts`'s `NEGATIVE_TEXT_EXPR` ranks out — so
 * they can never qualify. Kept as a standalone
 * expression (not a RegExp) so it can be interpolated into a browser-
 * context `page.evaluate` string, paralleling `INVALID_MARKER_EL_EXPR`.
 */
const SUBMIT_SHAPED_EL_EXPR = `((el) => {
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  if (tag === "button" && !el.getAttribute("type") && el.closest("form")) return true;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const isButtonLike = tag === "button" || role === "button";
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const text = norm(el.getAttribute("aria-label") || el.textContent || "");
  const isNegative = (t) => {
    const negatives = ["back", "cancel", "close", "dismiss", "save draft", "save for later", "previous"];
    return negatives.some((n) => t === n || t.startsWith(n + " ") || t.endsWith(" " + n));
  };
  if (isNegative(text)) return false;
  if (/\\bsubmit\\b/.test(text)) return true;
  if (/\\b(create|continue|next|confirm|proceed)\\b/.test(text)) return true;
  if (!isButtonLike) return false;
  const container = el.closest("form") || el.closest('[role="form"]');
  if (!container) return false;
  const isCandidate = (c) => {
    const cTag = (c.tagName || "").toLowerCase();
    const cRole = (c.getAttribute("role") || "").toLowerCase();
    if (cTag !== "button" && cRole !== "button") return false;
    const cText = norm(c.getAttribute("aria-label") || c.textContent || "");
    return !isNegative(cText);
  };
  const candidates = Array.from(container.querySelectorAll("*")).filter(isCandidate);
  return candidates.length === 1 && candidates[0] === el;
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
 * shadow roots — clicks it via the shared {@link clickActivationExpr} snippet
 * (a real `PointerEvent`/`MouseEvent` sequence plus native `click()`, not a
 * bare `new Event(...)` that a React/design-system handler would ignore; see
 * that module's docblock), and returns a structured result so the caller can
 * verify what happened without a second round-trip.
 *
 * Locate-only mode (`{ clickIfFound: false }`) is exposed for callers that
 * want to probe for a deep submit control before deciding whether to act
 * on it (e.g. to distinguish "no candidate anywhere" from "found but the
 * click cascade should try a different technique first").
 *
 * `options.root` overrides the traversal root expression (default
 * `"document"`). The string is interpolated verbatim into the generated
 * code, so a caller evaluating this expression via `Frame.evaluate` can
 * still pass `"document"` to root the walk in that frame's own document —
 * there is no captured outer `document` reference anywhere in this
 * expression, only the identifier resolved at evaluation time.
 */
export function buildDeepSubmitClickExpr(options?: {
  clickIfFound?: boolean;
  root?: string;
}): string {
  const clickIfFound = options?.clickIfFound ?? true;
  const root = options?.root ?? "document";
  return `(() => {
    const isSubmitShaped = ${SUBMIT_SHAPED_EL_EXPR};
    const deepElements = ${DEEP_ELEMENTS_EXPR};
    const candidates = deepElements(${root}).filter(isSubmitShaped);
    if (candidates.length === 0) return { found: false, clicked: false };
    const el = candidates[0];
    if (!${JSON.stringify(clickIfFound)}) return { found: true, clicked: false };
    ${clickActivationExpr("el")}
    return { found: true, clicked: true };
  })()`;
}

/** Structured result of {@link buildDeepSubmitClickExpr}'s `page.evaluate` call. */
export interface DeepSubmitClickResult {
  found: boolean;
  clicked: boolean;
}
