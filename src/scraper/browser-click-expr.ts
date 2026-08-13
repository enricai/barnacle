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
