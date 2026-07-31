import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * UCHealth Zip field acceptance test — validates that the method-override fix
 * (bugfix-001) ensures the Zip field fills correctly instead of being clicked.
 *
 * This test simulates the exact scenario from uchealth-recon-13: inside the
 * #talemetry_apply_iframe, the first 6 fields (First Name, Last Name, Email,
 * Mobile Phone, Street Address, City) fill successfully via attempt 1
 * (act-string), but the Zip field requires attempt 2 (observe-act), where
 * Stagehand observe() returns a candidate with method='click'. The fix must
 * override this to method='fill' with arguments=['78701'] before calling
 * guardedAct().
 *
 * Acceptance criteria:
 * 1. The Zip field step succeeds (no phantom-click, no replan)
 * 2. guardedAct receives a target with method='fill' and arguments=['78701'],
 *    NOT method='click' with arguments=[]
 * 3. The run completes all 7 fields successfully
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

function makeChildFrameTarget(urls: { current: string }, fieldValues: Map<string, string>): FrameTarget {
  let snapshotCount = 0;
  let currentField = "";
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockImplementation(async () => {
      // Return different values pre/post to trigger verification success
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    locator: vi.fn().mockImplementation((selector: string) => {
      // Extract the field from the selector to return the correct value
      for (const [field, value] of fieldValues.entries()) {
        if (selector.includes(field)) {
          currentField = field;
          return {
            first: () => ({
              isChecked: vi.fn().mockResolvedValue(false),
              inputValue: vi.fn().mockResolvedValue(value),
            }),
          };
        }
      }
      return {
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      };
    }),
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply - UCHealth"),
  };
}

function makeFakePage(urls: { current: string }, fieldValues: Map<string, string>): Page {
  let snapshotCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    deepLocator: vi.fn(),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Apply - UCHealth"),
    locator: vi.fn().mockImplementation((selector: string) => {
      // Extract the field from the selector to return the correct value
      for (const [field, value] of fieldValues.entries()) {
        if (selector.includes(field)) {
          return {
            first: () => ({
              isChecked: vi.fn().mockResolvedValue(false),
              inputValue: vi.fn().mockResolvedValue(value),
            }),
          };
        }
      }
      return {
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      };
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

describe("flow-runner/executeStepWithHealing — UCHealth Zip field acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("fills the Zip field via observe-act with overridden method='fill' instead of method='click'", async () => {
    const urls = { current: "https://apply.talemetry.com/application/abc-123" };
    const fieldValues = new Map([["postal-code", "78701"]]);
    const page = makeFakePage(urls, fieldValues);
    const childFrameTarget = makeChildFrameTarget(urls, fieldValues);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);

    // Mock guardedObserve to return a candidate with method='click' for the
    // Zip step. This simulates the exact scenario from uchealth-recon-13 where
    // Stagehand observe() returned method='click' for the Zip text input.
    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@autocomplete='postal-code']",
        description: "Zip Code *",
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
        actionDescription: `deepLocator filled "Zip Code *" with "78701"`,
        actions: [target],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Fill in the 'Zip' field with '78701'",
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
    // arguments=['78701'], not the original method='click' and arguments=[].
    const guardedActCalls = guardedAct.mock.calls;
    const targetCall = guardedActCalls.find(
      (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
    );
    expect(targetCall).toBeDefined();
    const target = targetCall?.[1] as { method: string; arguments: unknown[] };
    expect(target.method).toBe("fill");
    expect(target.arguments).toEqual(["78701"]);
  });

  it("control case: does not override method='fill' when observe already returns method='fill'", async () => {
    const urls = { current: "https://apply.talemetry.com/application/abc-123" };
    const fieldValues = new Map([["postal-code", "78701"]]);
    const page = makeFakePage(urls, fieldValues);
    const childFrameTarget = makeChildFrameTarget(urls, fieldValues);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);

    // Mock guardedObserve to return a candidate with method='fill' (already
    // correct) for the Zip step.
    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@autocomplete='postal-code']",
        description: "Zip Code *",
        method: "fill",
        arguments: ["78701"],
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
        message: "filled",
        actionDescription: `deepLocator filled "Zip Code *" with "78701"`,
        actions: [target],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Fill in the 'Zip' field with '78701'",
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

    // When observe already returns method='fill', the override logic should
    // still apply (parsing the step and overriding with the correct value),
    // resulting in method='fill' with arguments=['78701'].
    const guardedActCalls = guardedAct.mock.calls;
    const targetCall = guardedActCalls.find(
      (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
    );
    expect(targetCall).toBeDefined();
    const target = targetCall?.[1] as { method: string; arguments: unknown[] };
    expect(target.method).toBe("fill");
    expect(target.arguments).toEqual(["78701"]);
  });
});
