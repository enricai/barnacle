// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  PROMPT_EMPTY_VALUE_RX,
  PROMPT_SEARCH_SELECTORS,
  PROMPT_TRIGGER_SELECTORS,
  stripTrailingEmptyPlaceholder,
} from "@/scraper/flow-runner";

const doc = new Window().document;

describe("generic combobox trigger / search / placeholder constants", () => {
  it("trigger union matches a bare combobox with aria-expanded", () => {
    doc.body.innerHTML = `<a role="combobox" aria-expanded="false" id="t"></a>`;
    expect(doc.querySelector(PROMPT_TRIGGER_SELECTORS)?.id).toBe("t");
  });
  it("search union matches a self-combobox list input", () => {
    doc.body.innerHTML = `<input role="combobox" aria-autocomplete="list" id="s">`;
    expect(doc.querySelector(PROMPT_SEARCH_SELECTORS)?.id).toBe("s");
  });
  it.each(["-Select-", "— Make a Selection —", "Select One", "Please select..."])(
    "reads %j as empty",
    (s) => expect(PROMPT_EMPTY_VALUE_RX.test(s)).toBe(true)
  );
  it.each(["Selected Hospital", "Personal Email", "Select Medical Center Washington"])(
    "reads %j as filled",
    (s) => expect(PROMPT_EMPTY_VALUE_RX.test(s)).toBe(false)
  );
  it("stripTrailingEmptyPlaceholder strips a dashed trailing placeholder only", () => {
    expect(stripTrailingEmptyPlaceholder("Hospital -Select-")).toBe("Hospital");
    expect(stripTrailingEmptyPlaceholder("Selected Hospital")).toBe("Selected Hospital");
  });
});
