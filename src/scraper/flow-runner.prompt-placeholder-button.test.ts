import { describe, expect, it } from "vitest";

import { verifyPromptSelectorCommitted } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";

/**
 * A popup-trigger button whose own text is still a generic placeholder prompt
 * must read as unfilled, while a button showing a real value reads as filled.
 */

function buttonHtml(text: string): string {
  return `<div><button id="trigger" aria-haspopup="listbox" type="button">${text}</button></div>`;
}

describe("flow-runner/verifyPromptSelectorCommitted (placeholder-labelled trigger)", () => {
  it.each(["Select One", "Choose a country", "Please select...", "0 items selected"])(
    "reads %j as unfilled",
    async (text) => {
      const { target } = buildPromptWidgetHarness({ html: buttonHtml(text), popupByWidgetId: {} });
      const result = await verifyPromptSelectorCommitted(target, "//*[@id='trigger']");
      expect(result).toEqual({ isPromptWidget: true, committed: false });
    }
  );

  it.each(["No", "Mobile", "Selected Items Only"])("reads %j as filled", async (text) => {
    const { target } = buildPromptWidgetHarness({ html: buttonHtml(text), popupByWidgetId: {} });
    const result = await verifyPromptSelectorCommitted(target, "//*[@id='trigger']");
    expect(result).toEqual({ isPromptWidget: true, committed: true });
  });
});
