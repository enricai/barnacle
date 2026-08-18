import type { Element } from "happy-dom";
import { Window } from "happy-dom";

import type { FrameTarget } from "@/scraper/frame-target";

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
    widgetEl.appendChild(wrap);
  };

  const resolveFirst = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const locator = (selector: string) => ({
    first: () => ({
      click: async (): Promise<void> => {
        clicks.push(selector);
        const el = resolveFirst(selector);
        if (!el) return;
        // Trigger click → open this widget's popup.
        const widgetId = el.id || el.closest("[id]")?.id || "";
        const spec = params.popupByWidgetId[widgetId];
        if (spec) {
          const state = { spec, filter: "" };
          openState.set(widgetId, state);
          renderPopup(el.id ? el : (el.closest("[id]") as Element), state);
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
              // accessible text/label (as the real DOM does), exercising the
              // value union's own-text branch.
              owner.textContent = label;
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
            popup?.remove();
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
