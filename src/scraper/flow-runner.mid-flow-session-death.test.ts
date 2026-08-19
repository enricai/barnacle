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
      { selector: "input#f", description: "field", method: "fill" },
    ]);
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      // Session death is set as the LAST thing step 8's own act does — a
      // real dead session breaks everything downstream at once (not just
      // future steps), so every remaining page.url() read for step 8's own
      // verification, and every subsequent step, observes the dead session.
      if (stepCount === SESSION_DIES_AFTER_STEP) {
        killSession();
        return {
          success: true,
          message: "acted",
          actionDescription: "filled",
          actions: [{ selector: "input#f", description: "field", method: "fill" }],
        };
      }
      urls.current = `https://careers.example.org/jobs/123/apply?step=${stepCount}`;
      return {
        success: true,
        message: "acted",
        actionDescription: "filled",
        actions: [{ selector: "input#f", description: "field", method: "fill" }],
      };
    });

    // The exact rejection may surface either as the dedicated
    // `SessionTimeoutError` from `runHealingFlow`'s own per-step liveness
    // check (when death lands cleanly between steps) or as a
    // `StepVerificationError` from the cascade's own exhaustion (when death
    // lands mid-step, since `page.url()` is read throughout step
    // verification too) — both are the required outcome: the Promise
    // REJECTS instead of resolving as if the flow completed.
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
    ).rejects.toThrow();

    // The loop must not have iterated through every declared step — it
    // should have stopped once the dead session was detected, well short of
    // the flow's full step count.
    expect(stepCount).toBeLessThan(TOTAL_STEPS);
  });

  it("reports a distinct session-death error via the per-step liveness check when the session is already dead at a step boundary", async () => {
    const urls = { current: "https://careers.example.org/jobs/123/apply" };
    const { page, killSession } = makeFakePage(urls);
    const stagehand = makeStagehand();
    const steps = Array.from({ length: TOTAL_STEPS }, (_, i) => step(i));

    guardedObserve.mockResolvedValue([
      { selector: "input#f", description: "field", method: "fill" },
    ]);
    let stepCount = 0;
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

    // Session already dead before the flow starts — the very first thing
    // `runHealingFlow`'s loop does is the liveness check, so this proves the
    // check's own error message/type directly, independent of exactly when
    // within a step the cascade's own reads happen to notice.
    killSession();

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
    expect(stepCount).toBe(0);
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
