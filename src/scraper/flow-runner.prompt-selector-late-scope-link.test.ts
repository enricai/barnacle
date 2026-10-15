import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const OPTION_MARK = "data-bcl-prompt-opt-idx";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const HTML = `
<form>
  <div>
    <label for="a--input">Departure city</label>
    <div id="a" data-uxi-widget-type="multiselect">
      <div data-automation-id="selectedItem" role="option" id="chip-a">Lisbon</div>
      <input id="a--input" data-uxi-widget-type="selectinput" type="text" value="" />
    </div>
  </div>
  <div>
    <span id="lbl-b">Arrival city</span>
    <button id="b" type="button" aria-haspopup="listbox" aria-labelledby="lbl-b" aria-invalid="true"><span>Select</span></button>
  </div>
</form>`;

const CITIES = Array.from({ length: 22 }, (_, i) => `City ${i + 1}`);

function buildParams(page: unknown, target: unknown, step: string): never {
  return {
    stagehand: { act: vi.fn(), observe: vi.fn().mockResolvedValue([]) } as unknown as Stagehand,
    page: page as Page,
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
  } as never;
}

// The harness' waitForTimeout resolves instantly, which would exhaust the poll
// budget before the harness' real-timer aria-controls link can land.
function withRealWaits<T extends { waitForTimeout: unknown }>(page: T): T {
  page.waitForTimeout = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15)));
  return page;
}

describe("flow-runner/tryPromptSelectorPrimitive late scope link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits for a late aria-controls link and selects from the linked listbox", async () => {
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: {
        b: { options: CITIES, portaled: true, linkAfterOpen: true, linkDelayMs: 20 },
      },
    });

    const result = await executeStepWithHealing(
      buildParams(withRealWaits(page as never), target, "for 'Arrival city' select 'City 17'")
    );

    const doc = window.document;
    expect(result).toBe("completed");
    expect(doc.getElementById("b")?.textContent).toBe("City 17");
    expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).toBe(false);
    expect(doc.getElementById("a--input")?.getAttribute("value") ?? "").toBe("");
    expect(clicks.filter((c) => c.includes("chip") || c.includes("#a"))).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining('selected "City 17"'));
  });

  it("still commits from a never-linked document-scoped popup after the poll budget", async () => {
    const { page, target, window } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: {
        b: { options: CITIES, portaled: true, unlinkedPortal: true },
      },
    });

    const result = await executeStepWithHealing(
      buildParams(withRealWaits(page as never), target, "for 'Arrival city' select 'City 5'")
    );

    expect(result).toBe("completed");
    expect(window.document.getElementById("b")?.textContent).toBe("City 5");
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining('selected "City 5"'));
  });

  it("does not credit a document-scoped option-set change after a failed readback as a drill", async () => {
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: {
        b: { options: ["Alpha", "Beta"], portaled: true, unlinkedPortal: true },
      },
    });
    const doc = window.document;
    const realLocator = (target as { locator: (s: string) => unknown }).locator;
    // An option click that does not commit, while an unrelated document-level
    // listbox (a sibling's options) appears in its place.
    const interceptLocator = (selector: string): unknown => {
      const loc = realLocator(selector) as { first: () => { click: () => Promise<void> } };
      if (!selector.includes(OPTION_MARK) || selector.includes("-search")) return loc;
      const failedClick = async (): Promise<void> => {
        clicks.push(selector);
        doc.querySelector("[data-test-popup-for='b']")?.remove();
        const other = doc.createElement("div");
        other.setAttribute("role", "listbox");
        other.innerHTML = `<div role="option">Sibling X</div><div role="option">Sibling Y</div>`;
        doc.body.appendChild(other);
      };
      return { ...loc, click: failedClick, first: () => ({ ...loc.first(), click: failedClick }) };
    };
    (target as { locator: unknown }).locator = interceptLocator;
    (page as { locator: unknown }).locator = interceptLocator;

    await expect(
      executeStepWithHealing(
        buildParams(withRealWaits(page as never), target, "for 'Arrival city' select 'Beta'")
      )
    ).rejects.toThrow();

    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("did not commit; falling through to cascade")
    );
    expect(clicks.filter((c) => c.includes(OPTION_MARK))).toHaveLength(1);
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("drilled the popup"));
    expect(doc.getElementById("b")?.textContent).toBe("Select");
  });
});
