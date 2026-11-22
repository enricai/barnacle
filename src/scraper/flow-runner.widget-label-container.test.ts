import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const LONG = `Please describe in detail ${"x".repeat(175)}`;
const HTML = `
<form>
  <div>
    <label for="sel">Work authorization</label>
    <select id="sel" style="display:none"><option>Yes</option></select>
    <div id="a" role="combobox" aria-expanded="false" aria-labelledby="missing" aria-label="Select One Required" tabindex="0"></div>
  </div>
  <div>
    <label for="sel2">${LONG}</label>
    <select id="sel2" style="display:none"><option>Yes</option></select>
    <div id="b" role="combobox" aria-expanded="false" tabindex="0"></div>
  </div>
</form>`;

async function run(popupId: string, step: string) {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window, clicks } = buildPromptWidgetHarness({
    html: HTML,
    popupByWidgetId: { [popupId]: { options: ["Porto"], portaled: true } },
  });
  const labels: string[] = [];
  const origEval = target.evaluate.bind(target);
  (target as { evaluate: unknown }).evaluate = async (...a: unknown[]) => {
    const r = await (origEval as (...x: unknown[]) => Promise<unknown>)(...a);
    for (const c of (r as { candidates?: { label: string }[] })?.candidates ?? [])
      labels.push(c.label);
    return r;
  };
  await executeStepWithHealing({
    stagehand,
    page: page as unknown as Page,
    frameTarget: target,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 1,
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
    trajectory: [],
  } as never);
  return { doc: window.document, clicks, labels };
}

describe("widgetLabel container label[for]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("labels via the sibling select's label, not ancestor text", async () => {
    const { labels } = await run("a", "for 'Work authorization' select 'Porto'");
    expect(labels).toContain("Work authorization");
  });

  it("keeps a 200-char label untruncated", async () => {
    const { labels } = await run("b", `for '${LONG}' select 'Porto'`);
    expect(labels).toContain(LONG);
  });
});
