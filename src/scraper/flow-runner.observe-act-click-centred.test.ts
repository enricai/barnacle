import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * An observed click must be centred and hit-tested before Stagehand's own
 * click so a sticky footer cannot swallow it; fill steps are left alone.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();
const events: string[] = [];
let hitStates: string[] = [];

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

const URL = "https://example.com/apply";
const FRAME_SELECTOR = "iframe#apply_frame";

function makeFrameTarget(): FrameTarget {
  let snapshotCount = 0;
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      if (String(expr).includes("scrollIntoView")) {
        const state = hitStates.shift() ?? "hit";
        events.push(`centre:${state}`);
        return { state };
      }
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue("Alice"),
      }),
    }),
    url: () => Promise.resolve(URL),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(): Page {
  let snapshotCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    deepLocator: vi.fn(),
    url: () => URL,
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue("Alice"),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function stubObserve(method: string, description: string): void {
  guardedObserve.mockResolvedValue([
    { selector: "xpath=//*[@id='c']", description, method, arguments: [] },
  ]);
}

async function run(instruction: string): Promise<void> {
  resolveFrameTarget.mockResolvedValue(makeFrameTarget());
  await runHealingFlow({
    stagehand: {} as unknown as Stagehand,
    page: makeFakePage(),
    steps: [{ instruction, optional: false, upload: false, submitStep: false }],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    frameSelector: FRAME_SELECTOR,
  }).catch(() => undefined);
}

describe("flow-runner/executeStepWithHealing — observe-act click centring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    events.length = 0;
    hitStates = [];
    guardedAct.mockImplementation(async (_s, instructionOrTarget) => {
      if (typeof instructionOrTarget === "string") {
        return { success: false, message: "no candidates", actionDescription: "", actions: [] };
      }
      events.push("act");
      return {
        success: true,
        message: "ok",
        actionDescription: "acted",
        actions: [instructionOrTarget],
      };
    });
  });

  it("centres the observed click target before stagehand.act", async () => {
    stubObserve("click", "Click the Continue button");
    await run("Click the 'Continue' button");
    expect(events.slice(0, 2)).toEqual(["centre:hit", "act"]);
  });

  it("re-centres past a sticky-bar occlusion before acting", async () => {
    hitStates = ["occluded"];
    stubObserve("click", "Click the Continue button");
    await run("Click the 'Continue' button");
    expect(events.slice(0, 3)).toEqual(["centre:occluded", "centre:hit", "act"]);
  });

  it("does not act when the target stays occluded", async () => {
    hitStates = Array.from({ length: 50 }, () => "occluded");
    stubObserve("click", "Click the Continue button");
    await run("Click the 'Continue' button");
    expect(events).not.toContain("act");
  });

  it("does not pre-centre a fill step", async () => {
    stubObserve("fill", "Name input");
    await run("Fill in Name with Alice");
    expect(events[0]).toBe("act");
  });
});
