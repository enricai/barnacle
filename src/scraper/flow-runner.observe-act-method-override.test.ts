import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act branch (attempt 2/4) must override the candidate's method
 * and arguments when Stagehand observe() returns method='click' for a fill or
 * select step. This ensures a text input on a 'Fill in X with Y' step is
 * actuated as fill('Y'), not click(), even when Stagehand's observe returned
 * method='click'.
 *
 * This suite validates the override logic by mocking guardedObserve to return
 * a click candidate for fill/select steps, then capturing what guardedAct
 * receives to confirm the method and arguments were overridden before the act
 * call.
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

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";

function makeChildFrameTarget(urls: { current: string }): FrameTarget {
  let snapshotCount = 0;
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockImplementation(async () => {
      // Return different values pre/post to trigger verification success
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue("Alice"),
      }),
    }),
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(urls: { current: string }): Page {
  let snapshotCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    deepLocator: vi.fn(),
    url: () => urls.current,
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

describe("flow-runner/executeStepWithHealing — observe-act overrides method for fill/select steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("overrides observe candidate method='click' to method='fill' with arguments=['Alice'] for a fill step", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    const childFrameTarget = makeChildFrameTarget(urls);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);

    // Mock guardedObserve to return a candidate with method='click' for the
    // fill step. This simulates Stagehand observe() returning a click action
    // for a text input field.
    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@name='firstName']",
        description: "Name *",
        method: "click",
        arguments: [],
      },
    ]);

    // Mock guardedAct to fail on attempt 1 (act-string) and succeed on attempt
    // 2 (observe-act with overridden target).
    guardedAct.mockImplementation(async (_stagehand, instructionOrTarget, _options, _captureFn) => {
      if (typeof instructionOrTarget === "string") {
        // Attempt 1: act-string — fail so the cascade continues to attempt 2.
        return {
          success: false,
          message: "no candidates",
          actionDescription: "",
          actions: [],
        };
      }
      // Attempt 2: observe-act with overridden target — succeed.
      const target = instructionOrTarget as { method: string; arguments: unknown[] };
      return {
        success: true,
        message: "filled",
        actionDescription: "filled Name with Alice",
        actions: [target],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Fill in the 'Name' field with 'Alice'",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);

    // Verify the overridden target was used: find the call with a target
    // object (not a string) and assert it has method='fill' with
    // arguments=['Alice'], not the original method='click' and arguments=[].
    const guardedActCalls = guardedAct.mock.calls;
    const targetCall = guardedActCalls.find(
      (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
    );
    expect(targetCall).toBeDefined();
    const target = targetCall?.[1] as { method: string; arguments: unknown[] };
    expect(target.method).toBe("fill");
    expect(target.arguments).toEqual(["Alice"]);
  });

  it("overrides observe candidate method='click' to method='selectOption' with arguments=['California'] for a select step", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    // Create a custom frame target that returns "California" for inputValue to satisfy verification
    // and different snapshot values pre/post to trigger verification success via textChanged
    let snapshotCount = 0;
    const childFrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: vi.fn().mockImplementation(async () => {
        snapshotCount++;
        return { html: snapshotCount, text: `${snapshotCount}:California-value-${snapshotCount}` };
      }),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue("California"),
        }),
      }),
      url: () => Promise.resolve(urls.current),
      title: () => Promise.resolve("Apply"),
    };
    resolveFrameTarget.mockResolvedValue(childFrameTarget);

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//select[@name='state']",
        description: "State *",
        method: "click",
        arguments: [],
      },
    ]);

    guardedAct.mockImplementation(async (_stagehand, instructionOrTarget, _options, _captureFn) => {
      if (typeof instructionOrTarget === "string") {
        return {
          success: false,
          message: "no candidates",
          actionDescription: "",
          actions: [],
        };
      }
      const target = instructionOrTarget as { method: string; arguments: unknown[] };
      return {
        success: true,
        message: "selected",
        actionDescription: "selected State: California",
        actions: [target],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Select 'California' from the 'State' dropdown",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);

    const guardedActCalls = guardedAct.mock.calls;
    const targetCall = guardedActCalls.find(
      (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
    );
    expect(targetCall).toBeDefined();
    const target = targetCall?.[1] as { method: string; arguments: unknown[] };
    expect(target.method).toBe("selectOption");
    expect(target.arguments).toEqual(["California"]);
  });

  it("control case: does not override method for a click step (non-fill, non-select)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    const childFrameTarget = makeChildFrameTarget(urls);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//button[text()='Submit']",
        description: "Submit",
        method: "click",
        arguments: [],
      },
    ]);

    guardedAct.mockImplementation(async (_stagehand, instructionOrTarget, _options, _captureFn) => {
      if (typeof instructionOrTarget === "string") {
        return {
          success: false,
          message: "no candidates",
          actionDescription: "",
          actions: [],
        };
      }
      urls.current = "https://apply.acme.example/jobs/1/apply/submitted";
      const target = instructionOrTarget as { method: string; arguments: unknown[] };
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked Submit",
        actions: [target],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the Submit button",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);

    // For a click step, the method should remain 'click' with no override.
    const guardedActCalls = guardedAct.mock.calls;
    const targetCall = guardedActCalls.find(
      (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
    );
    expect(targetCall).toBeDefined();
    const target = targetCall?.[1] as { method: string; arguments: unknown[] };
    expect(target.method).toBe("click");
    expect(target.arguments).toEqual([]);
  });
});
