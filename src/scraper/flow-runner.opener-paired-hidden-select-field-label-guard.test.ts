import type { Page } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { tryDeterministicFieldLabelActuation } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Regression: a design-system combobox opener (already owned/resolved by
 * `tryPromptSelectorPrimitive`) is paired with a hidden native `<select>`
 * whose `<option>`s all carry an empty `value` attribute — `sel.value` stays
 * `""` no matter which option got picked, so a write there can never be
 * corroborated. The frame-scoped healing cascade's field-label-first routing
 * (`tryDeterministicFieldLabelActuation`) resolves candidates purely by
 * accessible name, independent of `tryPromptSelectorPrimitive`'s own
 * opener-paired-hidden-select exclusion — before this fix, a "select" step
 * whose only field-label match was this hidden `<select>` would actuate
 * `selectDeepLocatorCandidateOption` directly against it, a write the opener
 * widget never observes and that the empty option values can't verify.
 *
 * The select is hidden via the SAME off-screen-positioning technique
 * `OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR` exists to catch (non-zero layout box,
 * so `deep-locator-scan.ts`'s generic `IS_VISIBLE_EXPR` alone would NOT
 * filter it out) — the guard under test is the one that must exclude it.
 */

const QUESTION_LABEL = "How Did You Hear About Us?";
const STEP = `for '${QUESTION_LABEL}' select 'Job Boards'`;

const HTML = `
<div role="group" aria-labelledby="source-section">
  <span id="source-section">${QUESTION_LABEL}</span>
  <div id="src-widget" role="combobox" aria-haspopup="listbox" aria-controls="src-popup"
       aria-labelledby="source-section" aria-invalid="true" tabindex="0"><span></span></div>
  <select id="hidden-sel" name="source" class="form-control" aria-labelledby="source-section"
          style="position:absolute;left:-9999px">
    <option value="">Select</option>
    <option value="">Job Boards</option>
    <option value="">Referral</option>
  </select>
</div>`;

function buildHarness(): { page: unknown; target: FrameTarget } {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = HTML;

  const hiddenSelect = document.getElementById("hidden-sel");
  // Off-screen-positioned: a real, non-zero layout box (so the generic
  // deep-locator scan's own visibility filter alone would still surface it
  // as a candidate) shifted out of the viewport — the exact shape
  // `OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR` exists to recognize.
  Object.defineProperty(hiddenSelect, "getBoundingClientRect", {
    value: () => ({ width: 100, height: 20, top: 0, left: -9999, right: -9899, bottom: 20 }),
    configurable: true,
  });
  Object.defineProperty(hiddenSelect, "offsetParent", { value: document.body, configurable: true });

  const runExpr = (expr: string): unknown => {
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };
  const evaluate = async (expr: unknown): Promise<unknown> => runExpr(String(expr));

  const page = {
    evaluate,
    deepLocator: () => ({}),
    waitForTimeout: async (): Promise<void> => undefined,
  };
  const target = {
    evaluate,
    frame: {},
    frameSelector: "iframe#apply",
    declaredFrameSelector: "iframe#apply",
  } as unknown as FrameTarget;

  return { page, target };
}

describe("flow-runner/tryDeterministicFieldLabelActuation skips an opener-paired hidden select", () => {
  it("never writes to the paired hidden select when it is the only field-label match", async () => {
    const { page, target } = buildHarness();

    const outcome = await tryDeterministicFieldLabelActuation({
      page: page as unknown as Page,
      frameTarget: target,
      step: STEP,
      triedSelectors: [],
      timeoutOptions: { frameTarget: target },
    });

    expect(outcome.kind).toBe("no-match");

    const selectedIndex = (await target.evaluate(
      `document.getElementById("hidden-sel").selectedIndex`
    )) as number;
    // Untouched — still the placeholder option, never written by the guard.
    expect(selectedIndex).toBe(0);
  });

  it("still resolves and writes an ordinary, unpaired native select matched by field label", async () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="field">
        <label for="phone-type">Type</label>
        <select id="phone-type" name="phone-type">
          <option value="">Select</option>
          <option value="mobile">Mobile</option>
          <option value="home">Home</option>
        </select>
      </div>`;
    const phoneType = document.getElementById("phone-type");
    Object.defineProperty(phoneType, "offsetParent", { value: document.body, configurable: true });
    // happy-dom implements no layout engine (`getBoundingClientRect` always
    // 0x0), which `deep-locator-scan.ts`'s `IS_VISIBLE_EXPR` would read as
    // unrendered — stand in a real, non-zero, on-screen box so this select
    // surfaces as a candidate the way it would in a real browser.
    Object.defineProperty(phoneType, "getBoundingClientRect", {
      value: () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }),
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
    const page = {
      evaluate,
      deepLocator: () => ({}),
      waitForTimeout: async (): Promise<void> => undefined,
    };
    const target = {
      evaluate,
      frame: {},
      frameSelector: "iframe#apply",
      declaredFrameSelector: "iframe#apply",
    } as unknown as FrameTarget;

    const outcome = await tryDeterministicFieldLabelActuation({
      page: page as unknown as Page,
      frameTarget: target,
      step: `for 'Type' select 'Mobile'`,
      triedSelectors: [],
      timeoutOptions: { frameTarget: target },
    });

    expect(outcome.kind).toBe("actuated");
    const value = (await target.evaluate(`document.getElementById("phone-type").value`)) as string;
    expect(value).toBe("mobile");
  });
});
