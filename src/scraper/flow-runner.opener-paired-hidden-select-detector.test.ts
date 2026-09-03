import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR } from "@/scraper/flow-runner";

/**
 * Evaluates the real generated predicate source against a live happy-dom
 * element, mirroring the repo's existing pattern of exercising production
 * browser-context expression strings against genuine markup rather than a
 * mocked return value. happy-dom implements no layout engine (no real
 * `offsetParent`, as `prompt-widget-dom-harness.test-helper.ts` already
 * polyfills `document.evaluate`/`XPathResult` for the same class of gap), so
 * the fixture stands `offsetParent` in for the browser's own
 * `display:none`-driven null — a plain object for "has a layout box",
 * `null` for "does not".
 */
function withOffsetParent(el: HappyDomElement, offsetParent: unknown): HappyDomElement {
  Object.defineProperty(el, "offsetParent", { value: offsetParent, configurable: true });
  return el;
}

function opensAsHiddenShadowSelect(el: HappyDomElement): boolean {
  const fn = new Function(`return (${OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR});`)() as (
    node: unknown
  ) => boolean;
  return fn(el);
}

describe("flow-runner/OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR", () => {
  it("returns true for a dropdown-hide select paired with a role=combobox opener sibling", () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="bb-custom-select-container bb-customSelect">
        <span class="bb-custom-select-opener"
              role="combobox" aria-autocomplete="list" aria-expanded="false"
              aria-owns="bb-customSelect-6X0Nr-panel"
              aria-activedescendant="bb-customSelect-6X0Nr-selectedOption"
              aria-labelledby="bb-customSelect-6X0Nr-label"
              tabindex="0"><span></span></span>
        <select id="rcf3553" name="rcf3553" class="form-control dropdown-hide">
          <option value="">Select</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
    `;
    const select = document.getElementById("rcf3553") as unknown as HappyDomElement;
    expect(select).toBeTruthy();
    expect(opensAsHiddenShadowSelect(withOffsetParent(select, null))).toBe(true);
  });

  it("returns false for an ordinary visible select with no nearby combobox opener", () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="field">
        <label for="type">Type</label>
        <select id="type" name="type">
          <option value="mobile">Mobile</option>
          <option value="home">Home</option>
        </select>
      </div>
    `;
    const select = document.getElementById("type") as unknown as HappyDomElement;
    expect(select).toBeTruthy();
    expect(opensAsHiddenShadowSelect(withOffsetParent(select, document.body))).toBe(false);
  });

  it("returns false for a hidden select with no nearby combobox opener (offsetParent-only is not enough)", () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="field">
        <select id="hidden-plain" class="dropdown-hide" style="display:none">
          <option value="a">A</option>
        </select>
      </div>
    `;
    const select = document.getElementById("hidden-plain") as unknown as HappyDomElement;
    expect(select).toBeTruthy();
    expect(opensAsHiddenShadowSelect(withOffsetParent(select, null))).toBe(false);
  });

  it("returns false for a visible combobox opener's own select-shaped self (not a select tag)", () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <span class="bb-custom-select-opener" role="combobox" aria-owns="panel"></span>
    `;
    const opener = document.querySelector("[role='combobox']") as unknown as HappyDomElement;
    expect(opener).toBeTruthy();
    expect(opensAsHiddenShadowSelect(withOffsetParent(opener, null))).toBe(false);
  });
});
