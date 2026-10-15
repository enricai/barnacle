import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * A framework-managed checkbox keeps a stale `aria-invalid` on its wrapper
 * after being ticked; verifyDomEffect's click branch must credit it from its
 * own aria-checked, while native boxes keep the vacuous-click ancestor guard.
 */

const ACTION = {
  selector: "xpath=//input[@id='agree']",
  description: "I agree",
  method: "click",
};

function makeTarget(html: string, checked: boolean): FrameTarget {
  const win = new Window();
  win.document.body.innerHTML = html;
  const input = win.document.getElementById("agree") as unknown as { checked: boolean };
  input.checked = checked;
  const doc = {
    // happy-dom has no XPath; every probe in this branch targets the one checkbox.
    evaluate: () => ({ singleNodeValue: input }),
  };
  const run = new Function("document", "XPathResult", "expr", "return eval(expr);") as (
    d: unknown,
    x: unknown,
    e: string
  ) => unknown;
  return {
    frame: null,
    frameSelector: null,
    evaluate: async (expr: unknown) => run(doc, { FIRST_ORDERED_NODE_TYPE: 9 }, String(expr)),
    locator: () => ({
      first: () => ({ isChecked: async () => input.checked }),
    }),
  } as unknown as FrameTarget;
}

describe("verifyDomEffect click on aria-managed checkbox with stale aria-invalid", () => {
  it("credits aria-checked=true despite aria-invalid on an ancestor", async () => {
    const target = makeTarget(
      `<div aria-invalid="true"><input id="agree" type="checkbox" aria-checked="true"></div>`,
      true
    );
    expect(await verifyDomEffect(target, ACTION)).toBe(true);
  });

  it("does not credit aria-checked=false", async () => {
    const target = makeTarget(
      `<div><input id="agree" type="checkbox" aria-checked="false"></div>`,
      true
    );
    expect(await verifyDomEffect(target, ACTION)).toBe(false);
  });

  it("still rejects a native checked checkbox under an invalid ancestor", async () => {
    const target = makeTarget(
      `<div aria-invalid="true"><input id="agree" type="checkbox"></div>`,
      true
    );
    expect(await verifyDomEffect(target, ACTION)).toBe(false);
  });

  it("credits a native checked checkbox with no invalid marker", async () => {
    const target = makeTarget(`<div><input id="agree" type="checkbox"></div>`, true);
    expect(await verifyDomEffect(target, ACTION)).toBe(true);
  });
});
