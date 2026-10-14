import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A click on `<a target="_blank" href="/b">Apply</a>` opens a second tab. The
 * step's verification and every later primitive must run against that new tab,
 * and the original tab must no longer be driven.
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
const ANCHOR_HTML = '<a target="_blank" href="/b">Apply</a>';

interface FakePage {
  page: Page;
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
}

function fakePage(url: string): FakePage {
  const evaluate = vi.fn().mockResolvedValue(null);
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const page = {
    evaluate,
    url: () => url,
    title: vi.fn().mockResolvedValue("App"),
    waitForTimeout,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
  } as unknown as Page;
  return { page, evaluate, waitForTimeout };
}

function baseParams(
  stagehand: Stagehand,
  page: Page,
  onPageAdopted: (p: Page) => void
): Record<string, unknown> {
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
    onPageAdopted,
  };
}

describe("flow-runner/executeStepWithHealing — anchor target=_blank new tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: SELECTOR, description: "Apply", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  it(`continues the step on the page opened by ${ANCHOR_HTML}`, async () => {
    const original = fakePage("https://example.com/a");
    const opened = fakePage("https://example.com/b");
    const pages: Page[] = [original.page];
    // Real contexts return a fresh array per pages() call; the snapshot must not alias.
    const setActivePage = vi.fn();
    const stagehand = {
      context: { pages: () => [...pages], setActivePage },
    } as unknown as Stagehand;
    let originalEvaluateAtClick = -1;
    guardedAct.mockImplementation(async () => {
      originalEvaluateAtClick = original.evaluate.mock.calls.length;
      pages.push(opened.page);
      return {
        success: true,
        message: "clicked",
        actionDescription: "Apply",
        actions: [{ selector: SELECTOR, description: "Apply", method: "click" }],
      };
    });
    const onPageAdopted = vi.fn();

    const outcome = await executeStepWithHealing(
      baseParams(stagehand, original.page, onPageAdopted) as never
    );

    expect(outcome).toBe("completed");
    expect(setActivePage).toHaveBeenCalledWith(opened.page);
    expect(onPageAdopted).toHaveBeenCalledTimes(1);
    const adopted = onPageAdopted.mock.calls[0]?.[0] as Page;
    expect(adopted).toBe(opened.page);
    expect(adopted.url().endsWith("/b")).toBe(true);
    // Post-click snapshot and verification ran on the new tab only.
    expect(opened.evaluate).toHaveBeenCalled();
    expect(opened.waitForTimeout).toHaveBeenCalled();
    expect(original.evaluate.mock.calls.length).toBe(originalEvaluateAtClick);
    expect(original.waitForTimeout).not.toHaveBeenCalled();
  });
});
