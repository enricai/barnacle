import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CdpTransportClosedError } from "@/scraper/errors";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import { createSessionTeardownDetector } from "@/scraper/session-teardown";
import type { Logger } from "@/types/logging";

/**
 * Engine-layer coverage for the teardown-signal fix: `runHealingFlow` is the
 * same production entry point plugin dispatch calls (session-browserbase.ts
 * and session-steel.ts feed it the same `deathSignal`), so a mid-flow
 * teardown reaching it must reject the call, mirroring 0c5c57a's closing of
 * the equivalent gap for the liveness-check fix.
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

const TOTAL_STEPS = 10;
const TEARDOWN_FIRES_AFTER_STEP = 4;

const TEARDOWN_LOG_LINE = {
  level: 0 as const,
  category: "stagehand:v3",
  message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
};

function step(index: number): HealingFlowStep {
  return {
    instruction: `Fill in field ${index}`,
    optional: false,
    upload: false,
    submitStep: false,
  };
}

function makeFakePage(urls: { current: string }): Page {
  return {
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Details"),
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: () => [],
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

describe("flow-runner/runHealingFlow — session-teardown-detector deathSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with CdpTransportClosedError when the teardown detector's signal fires partway through the step array, without completing the remaining steps", async () => {
    const urls = { current: "https://portal.example.org/records/9/details" };
    const page = makeFakePage(urls);
    const stagehand = makeStagehand();
    const steps = Array.from({ length: TOTAL_STEPS }, (_, i) => step(i));
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();

    let stepCount = 0;
    guardedObserve.mockResolvedValue([
      { selector: "input#f", description: "field", method: "fill" },
    ]);
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      if (stepCount === TEARDOWN_FIRES_AFTER_STEP) {
        // Models Stagehand's transport-teardown log line arriving while this
        // step's own action is still in flight, so the only way out is the
        // deathSignal race — mirrors a real reaped CDP socket, where nothing
        // downstream of the transport ever settles again.
        watchLogLine(TEARDOWN_LOG_LINE);
        return new Promise(() => {});
      }
      urls.current = `https://portal.example.org/records/9/details?step=${stepCount}`;
      return {
        success: true,
        message: "acted",
        actionDescription: "filled",
        actions: [{ selector: "input#f", description: "field", method: "fill" }],
      };
    });

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        deathSignal,
      })
    ).rejects.toThrow(CdpTransportClosedError);

    expect(stepCount).toBeLessThan(TOTAL_STEPS);
  });

  it("resolves normally when the teardown detector's signal only fires after every step has already completed (control case)", async () => {
    const urls = { current: "https://portal.example.org/records/9/details" };
    const page = makeFakePage(urls);
    const stagehand = makeStagehand();
    const steps = Array.from({ length: TOTAL_STEPS }, (_, i) => step(i));
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();

    let stepCount = 0;
    guardedObserve.mockResolvedValue([
      { selector: "input#f", description: "field", method: "fill" },
    ]);
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      urls.current = `https://portal.example.org/records/9/details?step=${stepCount}`;
      return {
        success: true,
        message: "acted",
        actionDescription: "filled",
        actions: [{ selector: "input#f", description: "field", method: "fill" }],
      };
    });

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      deathSignal,
    });

    expect(result.lastStepIndex).toBe(TOTAL_STEPS - 1);
    expect(stepCount).toBe(TOTAL_STEPS);

    // End-of-run teardown log line (the 1.12.2 control shape from the
    // recon-1127 cross-version table) arrives only now — after the call has
    // already resolved — and must not retroactively turn the resolved
    // promise into a rejection or throw as an unhandled rejection.
    watchLogLine(TEARDOWN_LOG_LINE);
    await expect(deathSignal).rejects.toThrow(CdpTransportClosedError);
  });
});
