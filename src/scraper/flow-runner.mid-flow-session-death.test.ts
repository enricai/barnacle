import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the step-9-of-10 shape from
 * docs/recon-1123-flow-truncates-at-step-9-stagehand-370-shutdown.md: a
 * Stagehand session that dies partway through a flow must make
 * `runHealingFlow`'s returned Promise reject, not resolve as if every step
 * completed. bugfix-002/003 close this at the engine and CLI layers; this
 * covers the gap in `runHealingFlow` itself, which plugins call directly.
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
const SESSION_DIES_AFTER_STEP = 8;

function step(index: number): HealingFlowStep {
  return {
    instruction: `Fill in field ${index}`,
    optional: false,
    upload: false,
    submitStep: false,
  };
}

/**
 * Fake `Page` whose `url()` throws once `killSession()` has been called,
 * modeling a closed/dead Stagehand session mid-flow. `urls.current` advances
 * per step (mutated by the test's `guardedAct` mock) so the cascade's
 * `urlChanged` verification signal fires and each live step actually
 * verifies, matching `flow-runner.frame-midflow-runhealingflow.test.ts`'s
 * pattern.
 */
function makeFakePage(urls: { current: string }): { page: Page; killSession: () => void } {
  let dead = false;
  const page = {
    url: () => {
      if (dead) throw new Error("Target page, context or browser has been closed");
      return urls.current;
    },
    title: vi.fn().mockResolvedValue("Apply"),
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

  return {
    page,
    killSession: () => {
      dead = true;
    },
  };
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

describe("flow-runner/runHealingFlow — mid-flow session death", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects instead of resolving when the session dies after step 8 of a 10-step flow", async () => {
    const urls = { current: "https://careers.example.org/jobs/123/apply" };
    const { page, killSession } = makeFakePage(urls);
    const stagehand = makeStagehand();
    const steps = Array.from({ length: TOTAL_STEPS }, (_, i) => step(i));

    let stepCount = 0;
    guardedObserve.mockResolvedValue([
      { selector: `input#f${0}`, description: "field", method: "fill" },
    ]);
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      urls.current = `https://careers.example.org/jobs/123/apply?step=${stepCount}`;
      if (stepCount === SESSION_DIES_AFTER_STEP) {
        killSession();
      }
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
      })
    ).rejects.toThrow(/session appears closed\/dead/);

    // The loop must not have iterated through every declared step — it
    // should have stopped once the dead session was detected, well short of
    // the flow's full step count.
    expect(stepCount).toBeLessThan(TOTAL_STEPS);
  });

  it("resolves normally when the session stays alive for all steps (control case)", async () => {
    const urls = { current: "https://careers.example.org/jobs/123/apply" };
    const { page } = makeFakePage(urls);
    const stagehand = makeStagehand();
    const steps = Array.from({ length: TOTAL_STEPS }, (_, i) => step(i));

    let stepCount = 0;
    guardedObserve.mockResolvedValue([
      { selector: "input#f", description: "field", method: "fill" },
    ]);
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      urls.current = `https://careers.example.org/jobs/123/apply?step=${stepCount}`;
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
    });

    expect(result.lastStepIndex).toBe(TOTAL_STEPS - 1);
  });
});
