/**
 * Shared browser-context click-activation snippet. Two primitives —
 * `buildClickFrameCandidateExpr` (`deep-locator-scan.ts`) and
 * `buildClickByDeepIndexExpr` (`submit-control.ts`) — each need to activate a resolved element from inside
 * a `page.evaluate`/`Frame.evaluate` string. They used to dispatch bare
 * `new Event("mousedown"/"mouseup"/"click", { bubbles: true })`, which BUBBLES
 * (so analytics/telemetry listeners fire) but is NOT a `MouseEvent`/`PointerEvent`
 * instance — React's synthetic-event system and design-system widgets (Base Web,
 * etc.) refuse a bare `Event` as a real user activation. The observed symptom on
 * a markerless multi-select wizard: an option/toggle click reached the element
 * and its analytics pixel recorded the click, yet the widget's "N selected"
 * counter stayed flat because the selection never registered. This snippet
 * dispatches a realistic `PointerEvent`/`MouseEvent` gesture
 * (`pointerdown → mousedown → pointerup → mouseup`) and then triggers the
 * activation with EXACTLY ONE click: native `el.click()` when the element has it
 * (the trusted-path activation a `<button>` toggle listens for), else a single
 * synthetic `MouseEvent("click")`. It must never do BOTH — a synthetic `click`
 * dispatch plus a native `click()` fires a toggle handler twice
 * (select → deselect = net zero), re-creating the very phantom this snippet
 * exists to cure. Kept as a single interpolated string so all four primitives
 * stay identical (DRY) rather than drifting copies.
 */

/**
 * Emits a browser-context statement block that activates the element bound to
 * `elVar`: focus, then a `pointerdown → mousedown → pointerup → mouseup` gesture
 * using real `MouseEvent`/`PointerEvent` constructors (feature-detecting
 * `PointerEvent`, since a non-pointer environment still has `MouseEvent`),
 * followed by EXACTLY ONE click activation.
 *
 * `elVar` is interpolated verbatim as an already-in-scope identifier — the
 * caller resolves the element (e.g. `const el = matches[index]`) before
 * interpolating this block. The single click is delivered via native
 * `elVar.click()` when the element exposes one (every `HTMLElement` does; it is
 * the trusted-path activation that drives React/Base Web toggle state), and via
 * one synthetic `MouseEvent("click")` ONLY as the `else` for a non-`HTMLElement`
 * that has no native `click()`. The two paths are mutually exclusive on purpose:
 * dispatching a synthetic `click` AND calling native `click()` would fire the
 * element's handler twice, and on a toggle that is select → deselect = net zero.
 * The gesture events (down/up) are not click activations, so they never
 * double-fire the handler.
 */
/**
 * ARIA/role vocabulary a selection-state widget uses to mark its selected
 * option — shared between the n+16 actuation retarget below and
 * `flow-runner.ts`'s `selectionAncestorChanged` verification walk so the two
 * "what counts as the selectable element" definitions cannot drift apart.
 */
export const SELECTION_MARKER_ROLES = [
  "option",
  "tab",
  "switch",
  "radio",
  "checkbox",
  "menuitemcheckbox",
];

/**
 * Cross-vendor selector union for a selection-state widget that carries NO
 * standard selection `role` or `aria-*`/`data-state` marker — a component-kit
 * container whose selected-ness lives only in the library's own private
 * attribute. Member: `data-baseweb` (Uber Base Web). Add other
 * under-annotating kits here as they surface.
 */
export const WIDGET_KIT_SELECTION_MARKER_SELECTORS = ["[data-baseweb]"].join(",");

/**
 * Browser-context regex-literal source that recognizes a selection state
 * expressed purely as a CSS class-name token — a custom option widget authored
 * with no role, aria-state, or data-state marker, just a class swap on select
 * (e.g. `class="option selected"`). Matches both a bare state word
 * (`selected`/`selectable`/`active`/`checked`) and a hyphen-compound token
 * ENDING in one (`is-selected`, `Mui-selected`, `result-selected`,
 * `result-selectable`) — a custom option list is as likely to namespace its
 * state word onto a domain-specific prefix (`result-selectable` flipping to
 * `result-selected` on commit) as to use a bare/kit-prefixed one, and the
 * prior enumeration of exact whole tokens only ever matched the latter shape.
 * Shared verbatim (not re-derived) across every "does this element carry a
 * selection marker" predicate — the n+16 actuation retarget below,
 * `flow-runner.ts`'s `selectionAncestorChanged` / `clickTargetHasSelectionMarker`
 * verification walks, and the page-wide `DOM_SNAPSHOT_EXPR` diagnostic
 * signature — so a class-only widget can never be invisible to the strict
 * verification gate while still visible to the weak diagnostic one.
 */
export const SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC =
  "/(?:^|\\s)(?:[\\w-]*-)?(selected|selectable|active|checked)(?:\\s|$)/";

/**
 * Tag-agnostic class-token selector union — a candidate pre-filter for
 * {@link SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC}'s bare state words plus a
 * `[class*="-word"]` substring clause per hyphen-compound shape it also
 * recognizes (CSS has no "class token ending in" selector, so this
 * over-matches slightly — e.g. an unrelated `my-selected-item` token — and
 * relies on every caller re-testing candidates against the regex above for
 * the precise decision, exactly as `DOM_SNAPSHOT_EXPR`'s `clsHit` already
 * does). Shared between `DOM_SNAPSHOT_EXPR`'s page-wide signature and
 * `SELECTION_STATE_MAP_EXPR`'s baseline capture so a class-token-marked
 * element gets baseline coverage under the SAME vocabulary the diagnostic
 * signature already uses, rather than a second drifting list. Deliberately
 * NOT tag-qualified (no `button.selected`/`[role=option].selected`/etc.):
 * the whole point of this vocabulary extension is a widget authored with NO
 * role/aria-state/component-kit marker — often a bare `<li>` or `<div>` — so
 * gating the selector on a tag or role attribute would exclude exactly the
 * elements it exists to catch.
 */
export const SELECTION_MARKER_CLASS_SELECTOR_SRC =
  '.selected,.selectable,.active,.checked,[class*="-selected"],[class*="-selectable"],[class*="-active"],[class*="-checked"]';

/**
 * How far up from a resolved leaf {@link retargetToSelectionMarkerExpr} (and
 * `flow-runner.ts`'s `selectionAncestorChanged`) walks looking for the
 * option/toggle that carries the selection marker. Design-system options nest
 * their label 1-2 levels deep (a `<span title>` inside a `role="option"`,
 * plus the odd icon/wrapper); 6 covers that nesting without over-reaching into
 * an outer listbox/group.
 */
export const MAX_SELECTION_ANCESTOR_DEPTH = 6;

/**
 * Emits a browser-context statement block that reassigns `elVar` in place to
 * the NEAREST ancestor-or-self carrying a selection marker (a selection
 * `role`, an `aria-selected`/`aria-pressed`/`aria-checked`/`data-selected`/
 * `data-checked` attribute, or a {@link WIDGET_KIT_SELECTION_MARKER_SELECTORS}
 * component-kit marker) — mirroring the LABEL->checkbox/radio retarget that
 * already exists for native form controls. Stagehand's resolved xpath often
 * lands on a decorative descendant (an icon `<span>`, a label wrapper) of the
 * real selectable option; the site's commit handler is commonly bound to the
 * marker-bearing element itself and listens for `change`/selection events
 * rather than a bare click on an arbitrary descendant. If no ancestor within
 * {@link MAX_SELECTION_ANCESTOR_DEPTH} carries a marker, `elVar` is left
 * untouched (falls back to the originally resolved leaf) — this is purely a
 * "prefer a better target if one exists" retarget, never a lookup failure.
 *
 * Also declares `${matchedVar}` (a `let`, `false` unless a marker was found)
 * so the caller can gate a subsequent `change` dispatch on an ACTUAL
 * selection-marker match — dispatching `change` unconditionally on every
 * click resolved through this xpath fallback would fire on unrelated
 * elements too (a plain "Next" button, a link), tripping any delegated
 * `change` listener a site has for unrelated form validation.
 *
 * Leaves activation (the click gesture, and any subsequent `change` dispatch)
 * to the caller; this snippet only decides WHAT gets clicked, not HOW.
 */
export function retargetToSelectionMarkerExpr(elVar: string, matchedVar: string): string {
  return `{
    const __smRoles = new Set(${JSON.stringify(SELECTION_MARKER_ROLES)});
    const __smKitSel = ${JSON.stringify(WIDGET_KIT_SELECTION_MARKER_SELECTORS)};
    const __smClassRx = ${SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC};
    const __smHasMarker = (node) => {
      if (!node || typeof node.getAttribute !== "function") return false;
      if (
        node.hasAttribute("aria-selected") ||
        node.hasAttribute("aria-pressed") ||
        node.hasAttribute("aria-checked") ||
        node.hasAttribute("data-selected") ||
        node.hasAttribute("data-checked")
      ) return true;
      if (__smRoles.has((node.getAttribute("role") || "").toLowerCase())) return true;
      if (typeof node.matches === "function" && node.matches(__smKitSel)) return true;
      if (__smClassRx.test(node.getAttribute("class") || "")) return true;
      // A class-token-only widget whose click handler is broken never adds the
      // token to THIS node, but a sibling still carrying it (the untouched
      // prior selection) proves the group uses the class-token convention —
      // so this node is a member of that same selection group.
      if (node.parentElement && node.parentElement.children) {
        const __smSiblings = node.parentElement.children;
        for (let __smI = 0; __smI < __smSiblings.length; __smI++) {
          const __smSib = __smSiblings[__smI];
          if (__smSib !== node && __smClassRx.test(__smSib.getAttribute("class") || "")) return true;
        }
      }
      return false;
    };
    let __smNode = ${elVar};
    for (let __smDepth = 0; __smDepth < ${MAX_SELECTION_ANCESTOR_DEPTH} && __smNode; __smDepth++) {
      if (__smHasMarker(__smNode)) { ${elVar} = __smNode; ${matchedVar} = true; break; }
      __smNode = __smNode.parentElement;
    }
  }`;
}

export function clickActivationExpr(elVar: string): string {
  return `{
    if (typeof ${elVar}.focus === "function") { try { ${elVar}.focus(); } catch (e) {} }
    const __ceOpts = { bubbles: true, cancelable: true, composed: true, view: (typeof window !== "undefined" ? window : undefined), button: 0 };
    const __mouse = (type, buttons) => {
      try { return new MouseEvent(type, Object.assign({}, __ceOpts, { buttons: buttons })); }
      catch (e) { return new Event(type, { bubbles: true, cancelable: true }); }
    };
    const __pointer = (type, buttons) => {
      if (typeof PointerEvent === "function") {
        try { return new PointerEvent(type, Object.assign({}, __ceOpts, { buttons: buttons, pointerType: "mouse", isPrimary: true })); }
        catch (e) {}
      }
      return __mouse(type, buttons);
    };
    ${elVar}.dispatchEvent(__pointer("pointerdown", 1));
    ${elVar}.dispatchEvent(__mouse("mousedown", 1));
    ${elVar}.dispatchEvent(__pointer("pointerup", 0));
    ${elVar}.dispatchEvent(__mouse("mouseup", 0));
    if (typeof ${elVar}.click === "function") { try { ${elVar}.click(); } catch (e) {} }
    else { ${elVar}.dispatchEvent(__mouse("click", 0)); }
  }`;
}

/**
 * Recursive open-shadow-root walker: collects every element reachable from
 * `root`, descending into each open `shadowRoot` encountered. Composed as a
 * browser-context expression string (not runtime code) so it can be
 * interpolated into an `evaluate`/`evaluateHandle` body. Shared by
 * `submit-control.ts`'s submit-candidate ranking and
 * {@link RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR} below so the one
 * shadow-piercing walk never drifts into two copies.
 */
export const DEEP_ELEMENTS_EXPR = `((root) => {
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
 * Browser-context `(host) => Element | null` expression that resolves the
 * real interactive control living inside `host`'s own (open) shadow root.
 *
 * `document.evaluate` (the xpath engine a resolved `xpath=` selector is
 * delivered through) cannot cross a shadow boundary: on a custom-element
 * host whose real activation target is an interior shadow-DOM descendant,
 * the xpath resolves to the host itself, so a click dispatched there lands
 * on the host's own bounding box and never reaches the descendant's
 * handler. This walks `host.shadowRoot` (via {@link DEEP_ELEMENTS_EXPR})
 * for the first VISIBLE, ENABLED element that is itself clickable — a
 * `<button>`, an `<a href>`, an `<input type="submit"|"button">`, a
 * `[role="button"]`/`[role="link"]`, or an element carrying an explicit
 * `tabindex`/`onclick` affordance — and returns it. Deliberately does NOT
 * treat `typeof el.click === "function"` as a signal of interactivity:
 * `click()` is a generic method every `HTMLElement` exposes (wrapper
 * `<div>`s included), so that check alone would match the first visible
 * container in document order rather than the real control nested inside
 * it. Returns `null` when `host` has no shadow root, or no interactive
 * descendant qualifies, so the caller falls back unchanged to clicking
 * `host` itself.
 */
export const RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR = `((host) => {
  if (!host || !host.shadowRoot) return null;
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const isDisabled = (el) =>
    el.disabled === true || el.getAttribute("aria-disabled") === "true";
  const isInteractive = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (tag === "button" || tag === "select" || tag === "textarea") return true;
    if (tag === "a" && el.hasAttribute("href")) return true;
    if (tag === "input" && !["hidden"].includes((el.getAttribute("type") || "").toLowerCase())) return true;
    if (role === "button" || role === "link" || role === "checkbox" || role === "radio" || role === "menuitem")
      return true;
    if (el.hasAttribute("onclick")) return true;
    const tabIndex = el.getAttribute("tabindex");
    return tabIndex !== null && Number(tabIndex) >= 0;
  };
  const deepElements = ${DEEP_ELEMENTS_EXPR}(host.shadowRoot);
  for (const el of deepElements) {
    if (isInteractive(el) && isVisible(el) && !isDisabled(el)) return el;
  }
  return null;
})`;

/**
 * Result shape `buildMarkShadowInteractiveDescendantExpr`'s `page.evaluate`
 * call resolves to.
 */
export interface MarkShadowInteractiveDescendantResult {
  found: boolean;
}

/**
 * Builds a self-contained `page.evaluate` expression: resolves `xpathBody`
 * via `document.evaluate` (the same light-DOM resolution a trusted-click
 * delivers through), then — via {@link RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR}
 * — looks inside that host's own shadow root for the real interactive
 * descendant, stamping it with a throwaway `markerAttr="markerValue"`
 * attribute so the caller can locate it through a plain CSS attribute
 * selector afterward. A CSS selector (unlike xpath) pierces an open shadow
 * root — Stagehand's own `Locator` resolves a CSS selector via a querySelector
 * pass first, falling back to a shadow-piercing walk when that comes up
 * empty — so stamping the descendant and re-locating it via CSS is what lets
 * the caller deliver a genuinely trusted (CDP-level) click at the real
 * target instead of the host. Resolves `{ found: false }` (never throws)
 * when the xpath doesn't resolve or the host has no qualifying shadow
 * descendant, so the caller falls back to clicking the host via the
 * original xpath locator.
 */
export function buildMarkShadowInteractiveDescendantExpr(
  xpathBody: string,
  markerAttr: string,
  markerValue: string
): string {
  return `(() => {
    const r = document.evaluate(${JSON.stringify(xpathBody)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const host = r.singleNodeValue;
    if (!host) return { found: false };
    const resolveShadowInteractiveDescendant = ${RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR};
    const descendant = resolveShadowInteractiveDescendant(host);
    if (!descendant) return { found: false };
    descendant.setAttribute(${JSON.stringify(markerAttr)}, ${JSON.stringify(markerValue)});
    return { found: true };
  })()`;
}

/**
 * Builds the cleanup counterpart to {@link buildMarkShadowInteractiveDescendantExpr}:
 * re-resolves the same host via `xpathBody`, finds the marked descendant
 * inside its shadow root, and strips the throwaway marker attribute. Never
 * throws — the marker is purely a locator convenience and a leftover
 * attribute (if the host vanished mid-step, e.g. a genuine submit) has no
 * behavioral effect, so the caller treats this as fire-and-forget best-effort
 * cleanup.
 */
export function buildUnmarkShadowDescendantExpr(
  xpathBody: string,
  markerAttr: string,
  markerValue: string
): string {
  return `(() => {
    const r = document.evaluate(${JSON.stringify(xpathBody)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const host = r.singleNodeValue;
    if (!host || !host.shadowRoot) return;
    const marked = host.shadowRoot.querySelector(${JSON.stringify(`[${markerAttr}="${markerValue}"]`)});
    if (marked) marked.removeAttribute(${JSON.stringify(markerAttr)});
  })()`;
}
