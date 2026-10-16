import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act fill override must refuse a date-segment candidate before
 * any write, while a normal text input still fills.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();
const events: string[] = [];
let hitStates: string[] = [];
let segmentAnswer = false;

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
      if (String(expr).includes("isDateSegment(el)")) return segmentAnswer;
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

describe("flow-runner/executeStepWithHealing — observe-act fill on date segments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    events.length = 0;
    hitStates = [];
    segmentAnswer = false;
    guardedAct.mockImplementation(async (_s, instructionOrTarget) => {
      events.push(
        typeof instructionOrTarget === "string" ? "act-string" : `act:${instructionOrTarget.method}`
      );
      return { success: false, message: "no", actionDescription: "", actions: [] };
    });
    guardedObserve.mockImplementation(async () => [
      {
        selector: "xpath=//*[@id='f']",
        description: "Name input",
        method: "click",
        arguments: [],
      },
    ]);
  });

  it("never issues the fill act when the candidate is a date segment", async () => {
    segmentAnswer = true;
    await run("Fill in the Name field with 'Alice'");
    expect(events).not.toContain("act:fill");
  });

  it("still fills a normal text input candidate", async () => {
    await run("Fill in the Name field with 'Alice'");
    expect(events).toContain("act:fill");
  });
});
