import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A new-tab click must leave the context with one tab — the one the click
 * navigated to — and the run must keep driving it, even when the attempt that
 * clicked errored before it could look at the context.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP = "click Apply";
const SELECTOR = "css=a[target=_blank]";

interface FakePage {
  page: Page;
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakePage(url: string, onClose: () => void = () => undefined): FakePage {
  const close = vi.fn(async () => onClose());
  const evaluate = vi.fn().mockResolvedValue(null);
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const page = {
    evaluate,
    url: () => url,
    title: vi.fn().mockResolvedValue("App"),
    waitForTimeout,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    close,
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
  } as unknown as Page;
  return { page, evaluate, waitForTimeout, close };
}

function baseParams(stagehand: Stagehand, page: Page): Record<string, unknown> {
  return {
    stagehand,
    page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
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
  };
}

function openTabHarness(): {
  original: FakePage;
  opened: FakePage;
  pages: Page[];
  stagehand: Stagehand;
  openTab: () => void;
} {
  const pages: Page[] = [];
  const original = fakePage("https://example.com/a", () => {
    pages.splice(pages.indexOf(original.page), 1);
  });
  const opened = fakePage("https://example.com/b");
  pages.push(original.page);
  const stagehand = {
    context: { pages: () => [...pages], setActivePage: vi.fn() },
  } as unknown as Stagehand;
  return { original, opened, pages, stagehand, openTab: () => pages.push(opened.page) };
}

describe("flow-runner/executeStepWithHealing — new tab leaves a single driven tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: SELECTOR, description: "Apply", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  it("closes the stale tab and runs verification on the page at /b", async () => {
    const { original, opened, pages, stagehand, openTab } = openTabHarness();
    guardedAct.mockImplementation(async () => {
      openTab();
      return {
        success: true,
        message: "clicked",
        actionDescription: "Apply",
        actions: [{ selector: SELECTOR, description: "Apply", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(stagehand, original.page) as never);

    expect(outcome).toBe("completed");
    expect(pages).toEqual([opened.page]);
    expect(opened.page.url().endsWith("/b")).toBe(true);
    expect(opened.evaluate).toHaveBeenCalled();
  });

  it("drives the opened tab on the next attempt when the clicking attempt threw", async () => {
    const { original, opened, pages, stagehand, openTab } = openTabHarness();
    guardedAct.mockImplementationOnce(async () => {
      openTab();
      throw new Error("act timed out after the click landed");
    });
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Apply",
      actions: [{ selector: SELECTOR, description: "Apply", method: "click" }],
    });

    await executeStepWithHealing(baseParams(stagehand, original.page) as never).catch(
      () => undefined
    );

    expect(pages).toEqual([opened.page]);
    expect(opened.evaluate).toHaveBeenCalled();
    expect(original.close).toHaveBeenCalledTimes(1);
  });
});
