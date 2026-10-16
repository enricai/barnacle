import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * A trusted click on a prompt-selector trigger must land on the trigger, never
 * on a `position: sticky; bottom: 0` footer covering it. happy-dom has no
 * layout, so the geometry is modelled here: the trigger starts at top=690 in a
 * 736px viewport (under an 81px footer), only the centring pass moves it clear,
 * and a click delivered before that lands on the footer and opens nothing.
 */

const VIEWPORT_HEIGHT = 736;
const FOOTER_HEIGHT = 81;
const BUTTON_HEIGHT = 40;
const INITIAL_TOP = 690;
const CENTRED_TOP = (VIEWPORT_HEIGHT - BUTTON_HEIGHT) / 2;

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const INLINE_SHAPE_HTML = `
<div>
  <fieldset>
    <legend><span>Are you a returning customer?</span></legend>
    <button type="button" aria-haspopup="listbox" aria-invalid="true" aria-label=" Select One Required" id="returningTrigger">Select One</button>
  </fieldset>
  <footer style="position: sticky; bottom: 0; z-index: 1; height: 81px"></footer>
</div>`;

const OTHER_SHAPE_HTML = `
<div>
  <div role="group" aria-labelledby="shipping-section">
    <span id="shipping-section">Delivery</span>
    <label for="shippingMethod"><span>Preferred Shipping Method</span></label>
    <button id="shippingMethod" aria-haspopup="listbox" type="button"
            aria-invalid="true" aria-label="Preferred Shipping Method Required"></button>
  </div>
  <footer style="position: sticky; bottom: 0; z-index: 1; height: 81px"></footer>
</div>`;

function actResult(): ActResult {
  return { success: true, message: "clicked", actionDescription: "clicked", actions: [] };
}

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>, step: string) {
  return {
    stagehand: {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand,
    page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 3,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  };
}

/**
 * Wraps the harness target with occlusion geometry for the trigger: the centre
 * probe reports `occluded` while the point is under the footer and `hit` once
 * the (modelled) instant scroll moved it clear; a trusted click on the trigger
 * is delegated only when its point is not under the footer.
 */
function withStickyFooter(
  target: FrameTarget,
  triggerId: string,
  opts: { scrollClearsFooter: boolean }
): { target: FrameTarget; events: string[] } {
  const events: string[] = [];
  let top = INITIAL_TOP;
  const pointCovered = (): boolean => top + BUTTON_HEIGHT / 2 >= VIEWPORT_HEIGHT - FOOTER_HEIGHT;
  const isTrigger = (selector: string): boolean =>
    selector.includes(`#${triggerId}`) || selector.includes("data-");

  const evaluate = async (expr: unknown): Promise<unknown> => {
    const source = String(expr);
    if (!source.includes('scrollIntoView({ block: "center"'))
      return target.evaluate(expr as string);
    if (opts.scrollClearsFooter) top = CENTRED_TOP;
    const covered = pointCovered();
    events.push(covered ? "centre:occluded" : "centre:hit");
    return covered ? { state: "occluded", occluder: "footer" } : { state: "hit" };
  };

  const locator = (selector: string): ReturnType<FrameTarget["locator"]> => {
    const inner = target.locator(selector) as unknown as {
      first: () => { click: () => Promise<void> };
    };
    return {
      ...inner,
      click: async (): Promise<void> => {
        if (isTrigger(selector) && pointCovered()) {
          events.push("click:footer");
          return;
        }
        events.push("click:trigger");
        await inner.first().click();
      },
    } as unknown as ReturnType<FrameTarget["locator"]>;
  };

  return { target: { ...target, evaluate, locator } as unknown as FrameTarget, events };
}

describe("flow-runner/tryPromptSelectorPrimitive — trigger under a sticky footer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function run(opts: {
    html: string;
    id: string;
    options: string[];
    step: string;
    scrollClearsFooter: boolean;
  }) {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const harness = buildPromptWidgetHarness({
      html: opts.html,
      popupByWidgetId: { [opts.id]: { options: opts.options } },
    });
    const { target, events } = withStickyFooter(harness.target, opts.id, {
      scrollClearsFooter: opts.scrollClearsFooter,
    });
    const result = await executeStepWithHealing({
      ...baseParams(harness.page as unknown as Page, stagehandAct, opts.step),
      frameTarget: target,
    } as unknown as Parameters<typeof executeStepWithHealing>[0]).catch((err: unknown) => err);
    return { result, events, window: harness.window, stagehandAct };
  }

  it("centres the inline 'Select One' trigger clear of the footer, then clicks it and selects the option", async () => {
    const { result, events, window } = await run({
      html: INLINE_SHAPE_HTML,
      id: "returningTrigger",
      options: ["Yes", "No"],
      step: "In the 'Are you a returning customer?' Select One dropdown, select 'No'",
      scrollClearsFooter: true,
    });

    expect(result).toBe("completed");
    expect(events[0]).toBe("centre:hit");
    expect(events).toContain("click:trigger");
    expect(events).not.toContain("click:footer");
    expect(events.indexOf("click:trigger")).toBeGreaterThan(events.indexOf("centre:hit"));
    expect(events.filter((e) => e === "click:trigger").length).toBeGreaterThanOrEqual(2);
    expect(window.document.querySelector("#returningTrigger")?.textContent?.trim()).toBe("No");
  });

  it("lands on a different question's differently shaped trigger the same way", async () => {
    const { result, events, window } = await run({
      html: OTHER_SHAPE_HTML,
      id: "shippingMethod",
      options: ["Standard", "Express"],
      step: "for 'Preferred Shipping Method' select 'Express'",
      scrollClearsFooter: true,
    });

    expect(result).toBe("completed");
    expect(events[0]).toBe("centre:hit");
    expect(events).not.toContain("click:footer");
    expect(window.document.querySelector("#shippingMethod")?.textContent?.trim()).toBe("Express");
  });

  it("withholds the click and does not report success when the footer still covers the trigger", async () => {
    const { result, events, window } = await run({
      html: INLINE_SHAPE_HTML,
      id: "returningTrigger",
      options: ["Yes", "No"],
      step: "In the 'Are you a returning customer?' Select One dropdown, select 'No'",
      scrollClearsFooter: false,
    });

    expect(events).toContain("centre:occluded");
    expect(events).not.toContain("click:trigger");
    expect(events).not.toContain("click:footer");
    expect(result).not.toBe("completed");
    expect(result).toBeInstanceOf(Error);
    expect(window.document.querySelector("[role=listbox]")).toBeNull();
    expect(window.document.querySelector("#returningTrigger")?.textContent?.trim()).toBe(
      "Select One"
    );
  });
});
