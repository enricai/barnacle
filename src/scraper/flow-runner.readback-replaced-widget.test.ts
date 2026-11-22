import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 5,
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

const REPLACED_HTML = `
<div>
  <span id="src-label">Source</span>
  <div id="ctr">
    <span id="src-opener" role="combobox" aria-expanded="false" aria-owns="src-panel"
          aria-labelledby="src-label" tabindex="0"><span></span></span>
  </div>
</div>`;

const ISSUE_HTML = `
<div>
  <div><label id="lbl-x" for="src-select"><span>Source</span></label></div>
  <div id="ctr">
    <div class="wrap">
      <span id="src-opener" role="combobox" aria-expanded="false" aria-owns="src-panel"
            aria-labelledby="lbl-x" tabindex="0" style="opacity:0"><span></span></span>
      <select id="src-select" tabindex="-1" style="display:none"><option></option></select>
      <div id="src-panel" role="listbox"></div>
    </div>
    <a id="src-trigger" role="combobox" aria-expanded="false" tabindex="0" aria-label="Source"><span>-Select-</span></a>
  </div>
</div>`;

async function runReplaced(typed: string, html: string = REPLACED_HTML) {
  vi.clearAllMocks();
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window } = buildPromptWidgetHarness({
    html,
    popupByWidgetId: {
      [html === ISSUE_HTML ? "src-trigger" : "src-opener"]: {
        options: ["Referral", "\u2014 Enter Manually \u2014"],
      },
    },
  });
  const realEval = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
  (target as unknown as { evaluate: unknown }).evaluate = async (expr: string) => {
    if (typeof expr === "string" && expr.includes("-ctr=")) {
      const ctr = window.document.getElementById("ctr");
      if (ctr) ctr.innerHTML = `<input type="text" value="${typed}" />`;
    }
    return realEval.call(target, expr);
  };
  const params = baseParams(
    page as unknown as Page,
    stagehand,
    "Select '\u2014 Enter Manually \u2014' in the 'Source' dropdown",
    target
  );
  await executeStepWithHealing({ ...params, trajectory: [] } as never).catch(() => undefined);
  return (testLogger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
    String(c[0])
  );
}

describe("prompt readback when the widget replaces itself", () => {
  it("credits a replacement control holding exactly the option (alnum-compared)", async () => {
    const logs = await runReplaced("enter manually");
    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(true);
  });
  it("does not credit a different value", async () => {
    const logs = await runReplaced("enter manually please");
    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(false);
  });
  it("issue markup: credits the swapped-in input", async () => {
    const logs = await runReplaced("enter manually", ISSUE_HTML);
    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(true);
  });
  it("issue markup: refuses a different value", async () => {
    const logs = await runReplaced("something else", ISSUE_HTML);
    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(false);
  });
});

const SELECT_HTML = (optValue: string) => `
<div>
  <span id="src-label">Source</span>
  <div class="bb-custom-select-container">
    <span id="src-opener" role="combobox" aria-expanded="false" aria-owns="src-panel"
          aria-labelledby="src-label" tabindex="0"><span></span></span>
    <select id="src-select" aria-required="true"><option value="${optValue}"></option></select>
  </div>
</div>`;

async function runHiddenSelect(optValue: string) {
  vi.clearAllMocks();
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window } = buildPromptWidgetHarness({
    html: SELECT_HTML(optValue),
    popupByWidgetId: {
      "src-opener": {
        options: ["Referral", "— Enter Manually —"],
        // the opener itself commits different text, so only the hidden select can corroborate
        commitsInstead: "Unrelated",
      },
    },
  });
  // happy-dom has no layout, so stand in for the browser's display:none offsetParent
  const hidden = window.document.getElementById("src-select");
  if (hidden) Object.defineProperty(hidden, "offsetParent", { value: null, configurable: true });
  const params = baseParams(
    page as unknown as Page,
    stagehand,
    "Select '— Enter Manually —' in the 'Source' dropdown",
    target
  );
  await executeStepWithHealing({ ...params, trajectory: [] } as never).catch(() => undefined);
  return (testLogger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
    String(c[0])
  );
}

describe("hidden-select corroboration with an empty-text option", () => {
  it("credits when the option's value equals the requested text", async () => {
    const logs = await runHiddenSelect("\u2014 enter manually \u2014");

    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(true);
  });
  it("does not credit when the option's value is a different option", async () => {
    const logs = await runHiddenSelect("referral");
    expect(logs.some((l) => l.includes("prompt-selector primitive: selected"))).toBe(false);
  });
});
