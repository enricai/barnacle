import type { Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, hasUnfilledRequiredControlForStep } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * A popup-trigger button still showing its placeholder prompt must read as
 * unfilled in both the required-control probe and the primitive's commit
 * readback; the same button showing a chosen label reads as filled/committed.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeDomFrameTarget(html: string): FrameTarget {
  const window = new Window({ url: "https://careers.example.com/apply" });
  const document = window.document;
  document.body.innerHTML = html;
  const evaluate = (async (expr: unknown) => {
    const fn = new window.Function("document", "window", "CSS", `return (${String(expr)});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  }) as FrameTarget["evaluate"];
  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: vi.fn() as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://careers.example.com/apply"),
    title: () => Promise.resolve("Apply"),
  };
}

function triggerHtml(text: string): string {
  return `
    <div id="formField-phoneType">
      <label for="phone-trigger">Phone Device Type</label>
      <button id="phone-trigger" aria-haspopup="listbox" type="button">${text}</button>
    </div>`;
}

describe("hasUnfilledRequiredControlForStep — trigger button placeholder policy", () => {
  it.each(["Select One", "Choose a type"])("returns true for placeholder %j", async (text) => {
    const target = makeDomFrameTarget(triggerHtml(text));
    await expect(
      hasUnfilledRequiredControlForStep(target, "Select 'Mobile' for 'Phone Device Type'")
    ).resolves.toBe(true);
  });

  it("returns false for a button showing a chosen value", async () => {
    const target = makeDomFrameTarget(triggerHtml("Mobile"));
    await expect(
      hasUnfilledRequiredControlForStep(target, "Select 'Mobile' for 'Phone Device Type'")
    ).resolves.toBe(false);
  });
});

describe("tryPromptSelectorPrimitive readback — trigger button", () => {
  function run(html: string): ReturnType<typeof executeStepWithHealing> {
    const { page, target } = buildPromptWidgetHarness({
      html,
      popupByWidgetId: { phoneType: { options: ["Home", "Mobile", "Work"] } },
    });
    const stagehand = {
      act: vi.fn(),
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    return executeStepWithHealing({
      stagehand,
      page,
      frameTarget: target,
      step: "Select 'Mobile' for 'Phone Device Type'",
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
    } as unknown as Parameters<typeof executeStepWithHealing>[0]);
  }

  it("commits a placeholder trigger once it shows the chosen label", async () => {
    const html = `
<div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <label for="phoneType"><span>Phone Device Type</span></label>
    <button id="phoneType" aria-haspopup="listbox" type="button" aria-invalid="true">Select One</button>
  </div>
</div>`;
    await expect(run(html)).resolves.toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });
});
