import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the unguarded `page.title()` reads on the submit-
 * verification and step-failure-dump paths — `executeStepWithHealing`
 * previously awaited `page.title()` directly with no bound in three spots
 * (the two submit-judge reads plus `resolveDumpPageIdentity`'s dump-path
 * read), so a wedged CDP `Page.title` call would pend forever and the
 * cascade would never reach its "failed verification" throw. Real timers
 * throughout: `frameEvaluateTimeoutMs` is shrunk to a real (not faked) small
 * value so every watchdog in the 5-attempt cascade fires almost immediately
 * instead of after the real 30s default — the cascade chains many awaits per
 * attempt that don't play well with fake-timer `tickAsync` draining (see
 * `flow-runner.oopif-hang-watchdog.test.ts`'s comment on the same tradeoff).
 */
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      scraper: {
        ...actual.config.scraper,
        frameEvaluateTimeoutMs: 20,
      },
    },
  };
});

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(
  page: Page,
  stagehand: Stagehand
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Click the Submit button",
    optional: false,
    upload: false,
    submitStep: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: false,
    // Non-null so `requireSubmitEndpoint` is true and the cascade enters the
    // submit-verification branch that reads `page.title()`.
    submitEndpointPattern: "/apply/submit",
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — submit-verification page.title() probe is bounded", () => {
  it("degrades within the watchdog budget instead of hanging when page.title() never settles", async () => {
    const signalCounter = { n: 0 };
    const title = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://apply.acme.example/jobs/1/apply-portal/apply",
      title,
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        // A real submit click's network request lands between the pre/post
        // snapshot — bump the shared counter the moment `act` resolves,
        // same as flow-runner.test.ts's "succeeds on attempt 1" harness.
        signalCounter.n += 1;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Submit button",
          actions: [
            { selector: "button#submit", description: "Click the Submit button", method: "click" },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "button#submit", description: "submit", method: "click" }]),
    } as unknown as Stagehand;

    await expect(
      executeStepWithHealing({ ...baseParams(page, stagehand), signalCounter })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(title).toHaveBeenCalled();
  }, 10_000);
});
