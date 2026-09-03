import type { Page } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { trySelectPrimitive } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Reproduces the report's shape: a Base Web `bb-customSelect` opener whose
 * paired `<select>` is `dropdown-hide` (no layout box), plus an ordinary
 * visible native `<select>` elsewhere on the page (the working phone/address
 * "Type" fields) that must remain unaffected by the exclusion.
 */
const PAGE_HTML = `
  <div class="bb-custom-select-container bb-customSelect">
    <span class="bb-custom-select-opener"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="bb-customSelect-6X0Nr-panel"
          aria-activedescendant="bb-customSelect-6X0Nr-selectedOption"
          aria-labelledby="bb-customSelect-6X0Nr-label"
          tabindex="0"><span></span></span>
    <select id="rcf3553" name="rcf3553" class="form-control dropdown-hide">
      <option value="">Select</option>
      <option value="georgia">Georgia</option>
      <option value="florida">Florida</option>
    </select>
  </div>
  <div class="field">
    <label for="phone-type">Type</label>
    <select id="phone-type" name="phone-type">
      <option value="">Select</option>
      <option value="mobile">Mobile</option>
      <option value="home">Home</option>
    </select>
  </div>
`;

const testLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function buildHarness(): { page: unknown; target: FrameTarget } {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = PAGE_HTML;
  // happy-dom implements no layout engine, so `offsetParent` never reflects
  // `dropdown-hide`'s CSS — stand it in for the browser's own display:none
  // null, the same idiom the detector's own test uses.
  const hiddenSelect = document.getElementById("rcf3553");
  Object.defineProperty(hiddenSelect, "offsetParent", { value: null, configurable: true });
  const visibleSelect = document.getElementById("phone-type");
  Object.defineProperty(visibleSelect, "offsetParent", {
    value: document.body,
    configurable: true,
  });

  const runExpr = (expr: string): unknown => {
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };
  const evaluate = async (expr: unknown): Promise<unknown> => runExpr(String(expr));

  const page = { evaluate, waitForTimeout: async (): Promise<void> => undefined };
  const target = {
    evaluate,
    frame: null,
    frameSelector: null,
    declaredFrameSelector: null,
  } as unknown as FrameTarget;

  return { page, target };
}

describe("flow-runner/trySelectPrimitive skips an opener-paired hidden select", () => {
  it("falls through (null) without writing the hidden dropdown-hide select paired with a combobox opener", async () => {
    const { page, target } = buildHarness();

    const targetId = await trySelectPrimitive({
      page: page as unknown as Page,
      target,
      instruction: `select 'Georgia'`,
      logger: testLogger,
      anthropic: null,
    });

    expect(targetId).toBeNull();

    const hiddenValue = (await target.evaluate(
      `document.getElementById("rcf3553").value`
    )) as string;
    expect(hiddenValue).toBe("");
  });

  it("still matches and writes an ordinary visible native select elsewhere on the same page", async () => {
    const { page, target } = buildHarness();

    const targetId = await trySelectPrimitive({
      page: page as unknown as Page,
      target,
      instruction: `select 'Mobile'`,
      logger: testLogger,
      anthropic: null,
    });

    expect(targetId).toBe("phone-type");

    const value = (await target.evaluate(`document.getElementById("phone-type").value`)) as string;
    expect(value).toBe("mobile");
  });
});
