import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDeepMarkerCentreExpr,
  resetBillingErrorFlagForTests,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: async () => undefined,
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const HOST_XPATH = "xpath=//card-widget[1]";
const MARKER_ATTR = "data-barnacle-shadow-click-target";

/**
 * Builds the `page`/`FrameTarget` fixture pair for one scenario. `hasShadowDescendant`
 * models whether the resolved host carries an interactive shadow-DOM descendant:
 * `true` is the bug's own shape (a `card-widget` host wrapping a shadow `<button>`);
 * `false` is the sibling "the host IS the real target" shape the regression guard
 * covers. A click only advances the page's URL from its SECOND delivery onward —
 * modeling attempt 1's n+16 trusted-click fallback landing on the host (zero
 * effect, same as the bug report's "trusted CDP click, zero effect" evidence)
 * followed by attempt 2's trusted-click-retry delivering the click that actually
 * lands on the real control.
 */
function makeFixture(hasShadowDescendant: boolean): {
  page: Page;
  frameTarget: FrameTarget;
  clickedSelectors: string[];
  events: string[];
  landed: string[];
  getUrl: () => string;
} {
  const urls = { current: "https://apply.acme.example/onboard/a/1" };
  const clickedSelectors: string[] = [];
  const events: string[] = [];
  let clickCount = 0;
  let centred = false;
  const landed: string[] = [];

  const makeLocator = (): FrameTarget["locator"] =>
    vi.fn().mockImplementation((selector: string) => {
      const click = async (): Promise<void> => {
        clickedSelectors.push(selector);
        events.push("click");
        landed.push(centred ? "target" : "footer");
        centred = false;
        clickCount += 1;
        if (clickCount >= 2) {
          urls.current = "https://apply.acme.example/onboard/a/2";
        }
      };
      return {
        click,
        first: () => ({
          click,
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      };
    });

  const makeEvaluate = (): FrameTarget["evaluate"] =>
    vi.fn().mockImplementation(async (exprArg: unknown) => {
      const src = String(exprArg);
      if (src.includes("resolveShadowInteractiveDescendant")) {
        return hasShadowDescendant ? { found: true } : { found: false };
      }
      if (src.includes("removeAttribute")) return undefined;
      if (src.includes('block: "center"')) {
        events.push("centre");
        centred = true;
        return { state: "hit" };
      }
      // Every other evaluate() call in the cascade (pre/post DOM snapshots,
      // submit-shape probes, etc.) reads a flat, unchanging signal so attempt
      // 1's own trusted n+16 click classifies as a phantom (zero DOM delta).
      return { html: 0, text: "0:" };
    });

  const page = {
    evaluate: makeEvaluate(),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Onboard"),
    locator: makeLocator(),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const frameTarget: FrameTarget = {
    frame: null,
    frameSelector: null,
    evaluate: makeEvaluate(),
    locator: makeLocator(),
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Onboard"),
  };

  return { page, frameTarget, clickedSelectors, events, landed, getUrl: () => urls.current };
}

describe("buildDeepMarkerCentreExpr", () => {
  it("pierces shadow roots and centres before hit-testing", () => {
    const expr = buildDeepMarkerCentreExpr('[data-x="1"]');
    expect(expr).toContain("shadowRoot");
    expect(expr).toContain('block: "center"');
    expect(expr).toContain("elementFromPoint");
  });
});

describe("trusted-click-retry centres the target before the retry click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it.each([
    ["shadow descendant", true],
    ["plain element", false],
  ])("centres then clicks, lands on the target and advances (%s)", async (_label, hasShadow) => {
    const { page, frameTarget, events, landed, clickedSelectors, getUrl } = makeFixture(hasShadow);
    resolveFrameTarget.mockResolvedValue(frameTarget);
    guardedObserve.mockResolvedValue([
      { selector: HOST_XPATH, description: "target", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "target",
      actions: [{ selector: HOST_XPATH, description: "target", method: "click" }],
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the target to continue",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    const retryClickIdx = events.lastIndexOf("click");
    expect(events[retryClickIdx - 1]).toBe("centre");
    expect(landed[landed.length - 1]).toBe("target");
    expect(clickedSelectors[clickedSelectors.length - 1]?.includes(MARKER_ATTR)).toBe(hasShadow);
    if (!hasShadow) expect(clickedSelectors[clickedSelectors.length - 1]).toBe(HOST_XPATH);
    expect(result.lastStepIndex).toBe(0);
    expect(getUrl()).toBe("https://apply.acme.example/onboard/a/2");
  });
});
