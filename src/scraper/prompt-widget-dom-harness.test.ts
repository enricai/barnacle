import type { Element } from "happy-dom";
import { describe, expect, it } from "vitest";

import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";

/**
 * Harness-only smoke test: proves `buildPromptWidgetHarness` can render the
 * two DOM shapes every subsequent test in this plan depends on — an
 * empty-own-text `role="option"` whose accessible name lives elsewhere, and
 * two independent widgets whose listboxes never cross-render each other's
 * options — independent of any assertion about production behavior.
 */

const WIDGET_HTML = `
<div id="widget-a" data-uxi-widget-type="multiselect">
  <div data-automation-id="promptSelectionLabel"></div>
  <button type="button">Open</button>
</div>`;

const TWO_WIDGET_HTML = `
<div id="widget-a" data-uxi-widget-type="multiselect">
  <div data-automation-id="promptSelectionLabel"></div>
  <button type="button">Open A</button>
</div>
<div id="widget-b" data-uxi-widget-type="multiselect">
  <div data-automation-id="promptSelectionLabel"></div>
  <button type="button">Open B</button>
</div>`;

/** Direct (non-descendant) text nodes of an element, trimmed and joined. */
function ownText(el: {
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
}): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent || "")
    .join("")
    .trim();
}

describe("prompt-widget-dom-harness: empty-own-label option shapes", () => {
  it.each([
    ["aria-label", (el: Element) => el.getAttribute("aria-label")],
    [
      "aria-labelledby",
      (el: Element) => {
        const ref = el.getAttribute("aria-labelledby");
        return ref ? el.ownerDocument.getElementById(ref)?.textContent : null;
      },
    ],
    ["title", (el: Element) => el.getAttribute("title")],
    ["child-node", (el: Element) => el.querySelector(".prompt-option-label")?.textContent],
  ] as const)(
    "renders a %s-sourced option with empty own text/data-value",
    async (labelVia, readLabel) => {
      const { page, window } = buildPromptWidgetHarness({
        html: WIDGET_HTML,
        popupByWidgetId: { "widget-a": { options: [{ label: "No", labelVia }] } },
      });
      await (page as { locator: (s: string) => { first: () => { click: () => Promise<void> } } })
        .locator("#widget-a button")
        .first()
        .click();

      const optEl = window.document.querySelector("[role='option']") as unknown as Element;
      expect(optEl).toBeTruthy();
      expect(optEl.getAttribute("data-value")).toBe("");
      expect(
        ownText(
          optEl as unknown as {
            childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
          }
        )
      ).toBe("");
      expect(readLabel(optEl)).toBe("No");
    }
  );

  it("commits an empty-own-label option by resolving its accessible name", async () => {
    const { page, window } = buildPromptWidgetHarness({
      html: WIDGET_HTML,
      popupByWidgetId: { "widget-a": { options: [{ label: "No", labelVia: "aria-label" }] } },
    });
    const locator = (
      page as { locator: (s: string) => { first: () => { click: () => Promise<void> } } }
    ).locator;
    await locator("#widget-a button").first().click();
    await locator("[role='option']").first().click();

    const valueNode = window.document.querySelector("[data-automation-id='promptSelectionLabel']");
    expect(valueNode?.textContent).toBe("No");
  });

  it("mounts two widgets whose listboxes never cross-render each other's options", async () => {
    const { page, window } = buildPromptWidgetHarness({
      html: TWO_WIDGET_HTML,
      popupByWidgetId: {
        "widget-a": { options: ["Home", "Mobile"] },
        "widget-b": { options: ["Home", "Other"] },
      },
    });
    const locator = (
      page as { locator: (s: string) => { first: () => { click: () => Promise<void> } } }
    ).locator;
    await locator("#widget-a button").first().click();
    await locator("#widget-b button").first().click();

    const popupA = window.document.querySelector('[data-test-popup-for="widget-a"]');
    const popupB = window.document.querySelector('[data-test-popup-for="widget-b"]');
    expect(popupA).toBeTruthy();
    expect(popupB).toBeTruthy();
    const labelsA = Array.from(popupA?.querySelectorAll("[role='option']") ?? []).map((o) =>
      o.textContent?.trim()
    );
    const labelsB = Array.from(popupB?.querySelectorAll("[role='option']") ?? []).map((o) =>
      o.textContent?.trim()
    );
    expect(labelsA).toEqual(["Home", "Mobile"]);
    expect(labelsB).toEqual(["Home", "Other"]);
  });
});
