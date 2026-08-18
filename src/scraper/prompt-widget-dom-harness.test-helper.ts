import type { Element } from "happy-dom";
import { Window } from "happy-dom";

import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Mirrors {@link tryPromptSelectorPrimitive}'s private `PROMPT_WIDGET_MARK_ATTR`
 * (flow-runner.ts) — the harness needs it to resolve a click back to the
 * WIDGET a real click landed in, not just the clicked element's own `id`,
 * since production now prefers clicking a widget's interactive descendant
 * (e.g. its filter `<input>`) over the marked container itself.
 */
const PROMPT_WIDGET_MARK_ATTR = "data-bcl-prompt-idx";

/**
 * Real-DOM test harness for the prompt-selector primitive. Runs the primitive's
 * actual `page.evaluate(expr)` / `target.evaluate(expr)` expression STRINGS
 * against a live happy-dom document, and performs real DOM mutations for
 * `locator(sel).first().click()/fill()`, so a test exercises the production
 * union selectors and multi-phase open→filter→select→verify flow against
 * genuine markup — not a substring stub keyed to one vendor's attribute names.
 *
 * Why a helper file (not inline in the test): the same harness backs several
 * prompt-selector test files, and building a `Page`/`FrameTarget` pair whose
 * `evaluate` truly eval's the expression against a shared window is fiddly
 * enough to deserve one audited implementation.
 */

/** A popup this harness knows how to open, and the options it then renders. */
export interface PopupSpec {
  /** Options rendered into the listbox once the widget's trigger is clicked. */
  options: string[];
  /**
   * When true, options are withheld until the filter input is typed into
   * (the searchable/typeahead variant), modeling a widget that renders only a
   * filtered slice.
   */
  searchable?: boolean;
  /**
   * When true, render the popup as a `document.body`-level sibling linked to the
   * trigger by `aria-controls` (the ARIA-standard placement used by MUI/Radix/
   * react-select), instead of inline inside the widget (the Canvas/UXI kit).
   * The trigger gets `aria-controls` pointing at the portaled popup's id.
   */
  portaled?: boolean;
  /**
   * With `portaled`, prepend a non-listbox `role="status"` element id to the
   * trigger's `aria-controls` (an id-ref LIST), so scope resolution must pick the
   * listbox target rather than the first id. Exercises the multi-id path.
   */
  decoyRef?: boolean;
  /**
   * Leave the popup (with its marked option elements) in the DOM after commit
   * instead of removing it, so a stale option mark survives into a later step —
   * the inter-call collision FIX A's option-mark clearing must handle.
   */
  keepPopupMounted?: boolean;
}

/**
 * A fake `Page`+`FrameTarget` over a real happy-dom window. `evaluate` eval's
 * the expression against the window's globals; `locator(sel)` resolves the
 * first matching real element and its click/fill drive the registered popup
 * behavior (open popup, filter, commit a selection into the widget's value).
 */
export function buildPromptWidgetHarness(params: {
  html: string;
  /**
   * Maps a widget's stable id (the marked trigger's resolved element id, or a
   * selector) to the popup it opens. Keyed by the widget container's `id`.
   */
  popupByWidgetId: Record<string, PopupSpec>;
}): {
  page: unknown;
  target: FrameTarget;
  window: Window;
  clicks: string[];
  fills: { selector: string; value: string }[];
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = params.html;
  // happy-dom implements neither `XPathResult` nor `document.evaluate`.
  // Production `evaluate` expressions (e.g. `verifyPromptSelectorCommitted`)
  // resolve their resolved-action element via a `//*[@id='...']` xpath — the
  // only shape Stagehand's own resolutions and this suite's fixtures ever
  // need — so polyfill just that one pattern rather than a general XPath
  // engine.
  const win = window as unknown as { XPathResult?: unknown };
  if (!win.XPathResult) {
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (
      document as unknown as { evaluate: (expr: string) => { singleNodeValue: Element | null } }
    ).evaluate = (expr: string) => {
      const idMatch = expr.match(/^\/\/\*\[@id=(['"])([^'"]+)\1\]$/);
      const id = idMatch?.[2];
      return { singleNodeValue: id ? document.getElementById(id) : null };
    };
  }
  const clicks: string[] = [];
  const fills: { selector: string; value: string }[] = [];

  // Per-widget popup runtime state, keyed by the widget element the marker
  // attribute resolves to.
  const openState = new Map<string, { spec: PopupSpec; filter: string }>();

  const g = window as unknown as Record<string, unknown>;
  g.window = window;

  const runExpr = (expr: string): unknown => {
    // The production expressions are self-contained IIFEs referencing only
    // `document`, `window`, `CSS`, `RegExp`. Run them with those in scope.
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };

  /** Render a widget's popup listbox into the DOM (options + a filter input). */
  // The clickable trigger of a widget: the widget itself when it's a button/
  // combobox, else its first such descendant, else the widget element.
  const resolveTrigger = (widgetEl: Element): Element =>
    widgetEl.matches("button,[role='combobox']")
      ? widgetEl
      : widgetEl.querySelector("button,[role='combobox']") || widgetEl;

  const renderPopup = (widgetEl: Element, state: { spec: PopupSpec; filter: string }): void => {
    // Remove any prior popup for this widget.
    const existing = document.querySelector(`[data-test-popup-for="${widgetEl.id}"]`);
    existing?.remove();
    const wrap = document.createElement("div");
    wrap.setAttribute("data-test-popup-for", widgetEl.id);
    const shown = state.spec.searchable
      ? state.filter
        ? state.spec.options.filter((o) => o.toLowerCase().includes(state.filter.toLowerCase()))
        : []
      : state.spec.options;
    // A searchable widget filters via the widget's OWN trigger input (as the
    // real widget-kit DOM does — the trigger input IS the filter), not a
    // separate search box. Mark that input so a fill re-renders this popup.
    if (state.spec.searchable) {
      const triggerInput = widgetEl.querySelector("input");
      if (triggerInput) triggerInput.setAttribute("data-test-filter", widgetEl.id);
    }
    const searchHtml = "";
    const optsHtml = shown
      .map(
        (o) =>
          `<li role="option" data-automation-id="promptOption" data-automation-label="${o}">${o}</li>`
      )
      .join("");
    wrap.innerHTML = `${searchHtml}<ul role="listbox">${optsHtml}</ul>`;
    if (state.spec.portaled) {
      // Portal to document.body and link via aria-controls (Radix/MUI/react-select).
      const popupId = `portal-${widgetEl.id}`;
      wrap.id = popupId;
      const trigger = resolveTrigger(widgetEl);
      if (state.spec.decoyRef) {
        // Prepend a NON-listbox status region to aria-controls (id-ref list),
        // so scope resolution must pick the listbox, not the first id.
        const decoyId = `decoy-${widgetEl.id}`;
        const decoy = document.createElement("div");
        decoy.id = decoyId;
        decoy.setAttribute("role", "status");
        document.body.appendChild(decoy);
        trigger.setAttribute("aria-controls", `${decoyId} ${popupId}`);
      } else {
        trigger.setAttribute("aria-controls", popupId);
      }
      document.body.appendChild(wrap);
    } else {
      widgetEl.appendChild(wrap);
      if (state.spec.decoyRef) {
        // Inline popup, but the trigger's `aria-controls` points ONLY at a
        // non-listbox status region (no listbox ref). Scope resolution must fall
        // back to the INLINE subtree, not the resolved-but-listbox-less ref.
        const decoyId = `decoy-${widgetEl.id}`;
        const decoy = document.createElement("div");
        decoy.id = decoyId;
        decoy.setAttribute("role", "status");
        document.body.appendChild(decoy);
        resolveTrigger(widgetEl).setAttribute("aria-controls", decoyId);
      }
    }
  };

  const resolveFirst = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const locator = (selector: string) => ({
    count: async (): Promise<number> => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    },
    first: () => ({
      click: async (): Promise<void> => {
        clicks.push(selector);
        const el = resolveFirst(selector);
        if (!el) return;
        // An option click must be recognized BEFORE the trigger-open branch:
        // for an INLINE (non-portaled) popup, the option is rendered as a
        // descendant of the widget container, so `el.closest` on the widget's
        // mark attribute resolves to that SAME container a trigger click also
        // resolves to. Checking `[data-test-popup-for]` first — present only on
        // an option nested in an already-rendered popup, never on the bare
        // trigger — disambiguates the two without relying on marker ancestry.
        const inOpenPopup = el.closest("[data-test-popup-for]") !== null;
        // Trigger click → open this widget's popup. Resolve back to the
        // marked WIDGET (not just the clicked element's own id) — production
        // may click a widget's interactive descendant (e.g. its filter
        // input) rather than the marked container itself.
        const markedWidget = el.closest(`[${PROMPT_WIDGET_MARK_ATTR}]`);
        const widgetId = markedWidget?.id || el.id || el.closest("[id]")?.id || "";
        const spec = params.popupByWidgetId[widgetId];
        if (spec && !inOpenPopup) {
          const state = { spec, filter: "" };
          openState.set(widgetId, state);
          renderPopup((markedWidget || el.closest("[id]") || el) as Element, state);
          return;
        }
        // Option click → commit the option into the owning widget's value.
        if (el.getAttribute("role") === "option" || el.hasAttribute("data-automation-id")) {
          const popup = el.closest("[data-test-popup-for]");
          const owningId = popup?.getAttribute("data-test-popup-for") || "";
          const owner = owningId ? document.getElementById(owningId) : null;
          const label = el.getAttribute("data-automation-label") || el.textContent?.trim() || "";
          if (owner) {
            if (owner.tagName === "BUTTON") {
              // A near-standard button widget commits by updating its own
              // accessible label (as the real DOM does), exercising the value
              // union's own-text branch. If the button already wraps its label in
              // a <span> (some libraries do), commit into that span — the
              // child-wrapped-label case BUTTON_VALUE_EXPR must still read.
              const span = owner.querySelector("span");
              if (span) span.textContent = label;
              else owner.textContent = label;
              owner.setAttribute("aria-label", `${label} Required`);
            } else {
              let valueNode = owner.querySelector("[data-automation-id='promptSelectionLabel']");
              if (!valueNode) {
                valueNode = document.createElement("div");
                valueNode.setAttribute("data-automation-id", "promptSelectionLabel");
                owner.insertBefore(valueNode, owner.firstChild);
              }
              valueNode.textContent = label;
            }
            // Clear the aria-invalid marker the union reads as "unfilled" —
            // on the owner itself and on any descendant control.
            if (owner.getAttribute("aria-invalid") === "true") {
              owner.setAttribute("aria-invalid", "false");
            }
            owner.querySelectorAll("[aria-invalid='true']").forEach((n) => {
              n.setAttribute("aria-invalid", "false");
            });
            // Some widgets leave the popup in the DOM after commit (it's just
            // hidden). Keeping it mounted lets a stale option mark survive into a
            // later step — the scenario FIX A's option-mark clearing guards.
            if (!params.popupByWidgetId[owningId]?.keepPopupMounted) popup?.remove();
          }
        }
      },
      fill: async (value: string): Promise<void> => {
        fills.push({ selector, value });
        const el = resolveFirst(selector);
        if (!el) return;
        (el as unknown as { value: string }).value = value;
        // Typing into a widget's filter re-renders its popup slice.
        const filterFor = el.getAttribute("data-test-filter");
        const owner = filterFor ? document.getElementById(filterFor) : el.closest("[id]");
        const ownerId = filterFor || owner?.id || "";
        const state = openState.get(ownerId);
        if (state && owner) {
          state.filter = value;
          renderPopup(owner, state);
        }
      },
      isChecked: async (): Promise<boolean> => false,
      inputValue: async (): Promise<string> => "",
    }),
  });

  const evaluate = async (expr: unknown): Promise<unknown> => runExpr(String(expr));

  const page = {
    evaluate,
    url: () => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    locator,
    waitForTimeout: async (): Promise<void> => undefined,
  };

  const target = {
    evaluate,
    locator,
    url: async (): Promise<string> => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    frame: null,
    frameSelector: null,
    declaredFrameSelector: null,
  } as unknown as FrameTarget;

  return { page, target, window, clicks, fills };
}
