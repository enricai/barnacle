import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001: a top-window (no frame-seam) trusted-click-retry whose
 * attempt-1 phantom-clicked a custom-element host (`document.evaluate`
 * cannot cross a shadow boundary, so the xpath resolves to the host itself)
 * must resolve into the host's own open shadow root for the real interactive
 * descendant before delivering attempt 2's trusted click — not re-click the
 * host's own bounding box again. A generic `card-widget` host wrapping an
 * internal shadow `<button>` models the shape (no real site/plugin named),
 * matching CLAUDE.md's site-agnostic requirement.
 *
 * Mirrors `flow-runner.deep-locator-fallback.test.ts`'s "top-window
 * trusted-click-retry (no frame seam)" suite's mocking style: `resolveFrameTarget`
 * returns a `frame: null` target whose `locator`/`evaluate` are plain spies,
 * so the assertion is purely about WHICH selector attempt 2 delivers its
 * trusted click to, independent of real DOM/shadow-root mechanics.
 */

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
  getUrl: () => string;
} {
  const urls = { current: "https://apply.acme.example/onboard/a/1" };
  const clickedSelectors: string[] = [];
  let clickCount = 0;

  const makeLocator = (): FrameTarget["locator"] =>
    vi.fn().mockImplementation((selector: string) => ({
      first: () => ({
        click: async () => {
          clickedSelectors.push(selector);
          clickCount += 1;
          if (clickCount >= 2) {
            urls.current = "https://apply.acme.example/onboard/a/2";
          }
        },
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }));

  const makeEvaluate = (): FrameTarget["evaluate"] =>
    vi.fn().mockImplementation(async (exprArg: unknown) => {
      const src = String(exprArg);
      if (src.includes("resolveShadowInteractiveDescendant")) {
        return hasShadowDescendant ? { found: true } : { found: false };
      }
      if (src.includes("removeAttribute")) return undefined;
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

  return { page, frameTarget, clickedSelectors, getUrl: () => urls.current };
}

describe("flow-runner/executeStepWithHealing — trusted-click-retry resolves into a shadow-DOM host's real interactive descendant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("delivers attempt 2's trusted click to the shadow descendant, not the host's own bounding box, when the host has an open shadow root", async () => {
    const { page, frameTarget, clickedSelectors } = makeFixture(true);
    resolveFrameTarget.mockResolvedValue(frameTarget);

    guardedObserve.mockResolvedValue([
      { selector: HOST_XPATH, description: "card widget", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "card widget",
      actions: [{ selector: HOST_XPATH, description: "card widget", method: "click" }],
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the card widget to continue",
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

    expect(result.lastStepIndex).toBe(0);
    // Attempt 1's (n+16) click landed on the host xpath, zero effect.
    expect(clickedSelectors[0]).toBe(HOST_XPATH);
    // Attempt 2's trusted-click-retry must deliver its click to the marked
    // shadow descendant — a CSS attribute selector, never the host's own
    // xpath again.
    const retryClickedSelector = clickedSelectors[1];
    expect(retryClickedSelector).toBeDefined();
    expect(retryClickedSelector).not.toBe(HOST_XPATH);
    expect(retryClickedSelector).toContain(MARKER_ATTR);

    const infoLines = (
      testLogger.info as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => String(c[0]));
    expect(
      infoLines.some(
        (line) => line.includes("trusted-click-retry") && line.includes("shadow descendant")
      )
    ).toBe(true);
  });

  it("falls back unchanged to clicking the host itself when it has no shadow root (no regression on the existing path)", async () => {
    const { page, frameTarget, clickedSelectors } = makeFixture(false);
    resolveFrameTarget.mockResolvedValue(frameTarget);

    guardedObserve.mockResolvedValue([
      { selector: HOST_XPATH, description: "plain button", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "plain button",
      actions: [{ selector: HOST_XPATH, description: "plain button", method: "click" }],
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the button to continue",
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

    expect(result.lastStepIndex).toBe(0);
    // Both attempt 1's n+16 click and attempt 2's trusted-click-retry land on
    // the SAME host xpath — no shadow-descendant marker is ever constructed.
    expect(clickedSelectors[0]).toBe(HOST_XPATH);
    expect(clickedSelectors[1]).toBe(HOST_XPATH);
    expect(clickedSelectors.every((s) => !s.includes(MARKER_ATTR))).toBe(true);

    const infoLines = (
      testLogger.info as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => String(c[0]));
    expect(
      infoLines.some(
        (line) => line.includes("trusted-click-retry") && line.includes("shadow descendant")
      )
    ).toBe(false);
  });
});
