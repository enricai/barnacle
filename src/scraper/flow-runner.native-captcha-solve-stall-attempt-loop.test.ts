import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";

import {
  type AttemptRecord,
  executeStepWithHealing,
  wireSignalCapture,
} from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

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

const APPLY_STEP = "click the continue button";

function stalledPage(): { page: Page; emit: (v: string) => void } {
  const handlers = new Map<string, (e: unknown) => void>();
  const session = {
    on: (n: string, h: (e: unknown) => void) => handlers.set(n, h),
    off: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
  const page = {
    evaluate: vi
      .fn()
      .mockImplementation(async (expr: unknown) => answerCentreHitTest(expr) ?? null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => "https://apply.example.com/apply",
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => session,
    mainFrameId: () => "m",
  } as unknown as Page;
  wireSignalCapture(page, {
    counter: { n: 0 },
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    getCurrentPhase: () => "flow",
    getCurrentPageOrigin: () => "",
  });
  const emit = (v: string) =>
    handlers.get("Runtime.consoleAPICalled")?.({ args: [{ type: "string", value: v }] });
  return { page, emit };
}

describe("flow-runner/executeStepWithHealing — stalled native captcha solve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=button#go", description: "Continue", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Continue",
      actions: [{ selector: "css=button#go", description: "Continue", method: "click" }],
    });
  });

  it("ends the step with native-captcha-solve-stalled without re-clicking", async () => {
    vi.useFakeTimers();
    try {
      const { page, emit } = stalledPage();
      emit("browserbase-solving-started");
      const attemptsByFailure: AttemptRecord[][] = [];
      const p = executeStepWithHealing({
        stagehand: {} as unknown as Stagehand,
        page,
        step: APPLY_STEP,
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
        onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      } as never);
      const settled = p.then(
        () => null,
        (e: unknown) => e as Error
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(attemptsByFailure[0]?.map((a) => a.attempt)).toEqual([1]);
      expect(guardedAct).toHaveBeenCalledTimes(1);
      expect(
        (testLogger.warn as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("native-captcha-solve-stalled")
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("control: a finished solve is not reported as stalled", async () => {
    vi.useFakeTimers();
    try {
      const { page, emit } = stalledPage();
      emit("browserbase-solving-started");
      emit("browserbase-solving-finished");
      const attemptsByFailure: AttemptRecord[][] = [];
      const p = executeStepWithHealing({
        stagehand: {} as unknown as Stagehand,
        page,
        step: APPLY_STEP,
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
        onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      } as never);
      const settled = p.then(
        () => null,
        (e: unknown) => e as Error
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const err = await settled;
      void err;
      expect(
        (testLogger.warn as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("native-captcha-solve-stalled")
        )
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
