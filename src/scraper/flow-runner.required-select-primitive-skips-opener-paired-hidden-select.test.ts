import type { Page } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { tryFillRequiredSelectsPrimitive } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Same shape as the trySelectPrimitive regression, but for the catch-all
 * "for any remaining required question" path: a required-and-empty
 * `bb-customSelect` opener whose paired `<select>` is `dropdown-hide` (no
 * layout box) must not be reported committed or written to, while an
 * ordinary required-and-empty visible native `<select>` still gets filled.
 */
const HIDDEN_OPENER_PAIRED_HTML = `
  <div class="bb-custom-select-container bb-customSelect">
    <span class="bb-custom-select-opener"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="bb-customSelect-6X0Nr-panel"
          aria-activedescendant="bb-customSelect-6X0Nr-selectedOption"
          aria-labelledby="bb-customSelect-6X0Nr-label"
          tabindex="0"><span></span></span>
    <select id="rcf3553" name="rcf3553" class="form-control dropdown-hide" required>
      <option value="">Select</option>
      <option value="georgia">Georgia</option>
      <option value="florida">Florida</option>
    </select>
  </div>
`;

// The hidden select precedes the visible one in DOM order so an
// unfiltered-vs-filtered index desync (the bug this fix closes) would
// misresolve `applySelectValue`'s selIdx onto the wrong element.
const HIDDEN_THEN_VISIBLE_SELECT_HTML = `
  ${HIDDEN_OPENER_PAIRED_HTML}
  <div class="field">
    <label for="phone-type">Type</label>
    <select id="phone-type" name="phone-type" required>
      <option value="" disabled selected>Select</option>
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

function buildHarness(html: string): {
  page: unknown;
  target: FrameTarget;
  evaluate: (expr: unknown) => Promise<unknown>;
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = html;
  // happy-dom implements no layout engine, so `offsetParent` never reflects
  // `dropdown-hide`'s CSS — stand it in for the browser's own display:none
  // null, the same idiom the detector's own test uses.
  const hiddenSelect = document.getElementById("rcf3553");
  if (hiddenSelect) {
    Object.defineProperty(hiddenSelect, "offsetParent", { value: null, configurable: true });
  }
  const visibleSelect = document.getElementById("phone-type");
  if (visibleSelect) {
    Object.defineProperty(visibleSelect, "offsetParent", {
      value: document.body,
      configurable: true,
    });
  }

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

  return { page, target, evaluate };
}

describe("flow-runner/tryFillRequiredSelectsPrimitive skips an opener-paired hidden select", () => {
  it("does not report all-committed and leaves the hidden dropdown-hide select untouched when it's the only candidate", async () => {
    const { page, target, evaluate } = buildHarness(HIDDEN_OPENER_PAIRED_HTML);

    const allCommitted = await tryFillRequiredSelectsPrimitive({
      page: page as unknown as Page,
      target,
      instruction: "fill any remaining required question",
      logger: testLogger,
      anthropic: null,
    });

    expect(allCommitted).toBe(false);

    const hiddenValue = (await evaluate(`document.getElementById("rcf3553").value`)) as string;
    expect(hiddenValue).toBe("");
  });

  it("still fills an ordinary required-empty visible select that follows the hidden one in DOM order", async () => {
    const { page, target, evaluate } = buildHarness(HIDDEN_THEN_VISIBLE_SELECT_HTML);

    const allCommitted = await tryFillRequiredSelectsPrimitive({
      page: page as unknown as Page,
      target,
      instruction: "fill any remaining required question",
      logger: testLogger,
      anthropic: null,
    });

    expect(allCommitted).toBe(true);

    const hiddenValue = (await evaluate(`document.getElementById("rcf3553").value`)) as string;
    expect(hiddenValue).toBe("");

    const visibleValue = (await evaluate(`document.getElementById("phone-type").value`)) as string;
    expect(visibleValue).toBe("mobile");
  });
});
