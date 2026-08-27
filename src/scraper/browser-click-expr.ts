/**
 * Shared browser-context click-activation snippet. Three primitives —
 * `buildClickFrameCandidateExpr` (`deep-locator-scan.ts`),
 * `buildDeepSubmitClickExpr` (`deep-query.ts`), and `buildClickByDeepIndexExpr`
 * (`submit-control.ts`) — each need to activate a resolved element from inside
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
 * (e.g. `class="option selected"`). Shared verbatim (not re-derived) across every
 * "does this element carry a selection marker" predicate — the n+16 actuation
 * retarget below, `flow-runner.ts`'s `selectionAncestorChanged` /
 * `clickTargetHasSelectionMarker` verification walks, and the page-wide
 * `DOM_SNAPSHOT_EXPR` diagnostic signature — so a class-only widget can never
 * be invisible to the strict verification gate while still visible to the
 * weak diagnostic one.
 */
export const SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC =
  "/(?:^|\\s)(selected|active|checked|Mui-selected|is-selected)(?:\\s|$)/";

/**
 * Tag-agnostic class-token selector union — one bare `.token` clause per
 * token {@link SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC} recognizes — shared
 * between `DOM_SNAPSHOT_EXPR`'s page-wide signature and
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
  ".selected,.active,.checked,.Mui-selected,.is-selected";

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
