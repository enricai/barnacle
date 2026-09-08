import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-registry-retry-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-registry-retry-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Exercises the bounded registry-retry loop this subtask adds around the
 * captchaGated solve+inject+registryState-check+poll sequence: a transient
 * registry-empty result on the first attempt (the render callback hadn't
 * attached to the capture registry yet) must be retried within budget rather
 * than failing the step outright, succeeding once a later attempt observes a
 * populated registry with a confirmed transition.
 */

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
    step: "Solve the captcha and submit the application",
    optional: false,
    upload: false,
    submitStep: true,
    captchaGated: true,
    flowHasSubmitSemantics: true,
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
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: "type=next",
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — captchaGated registry-empty bounded retry", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("retries the solve+inject sequence when registryState=empty on attempt 1, and completes once attempt 2 observes a populated registry with a confirmed transition", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    let solveInjectCallCount = 0;
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        solveInjectCallCount += 1;
        // Attempt 1's inject "succeeds" (token set) but the registry hasn't
        // attached yet; only from attempt 2 onward does the widget's own
        // registry get populated by the (fake) re-asserted capture install.
        return { injected: true, hasForm: true, callbackDiscovered: false };
      }
      if (src.includes('return "absent"')) {
        return solveInjectCallCount >= 2 ? "populated" : "empty";
      }
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      if (src.includes("dispatchEvent")) return undefined;
      if (src.includes("requestSubmit")) return undefined;
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });

    const page = {
      evaluate,
      url: () => "https://apply.example.com/application/abc-123",
      title: vi.fn().mockResolvedValue(""),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      // Real setTimeout-backed waitForTimeout so `vi.runAllTimersAsync()` can
      // drive attempt 1's full CAPTCHA_TRANSITION_POLL_MS (45s) interval loop
      // to its unconfirmed end before the retry kicks in.
      waitForTimeout: vi
        .fn()
        .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    } as unknown as Page;
    const stagehand = {} as Stagehand;

    // Only visible once the second solve+inject attempt has run, so
    // attempt 1's waitForTransitionBody check can never see it — the
    // confirmed transition can only come from attempt 2.
    const writeConfirmingCaptureAfterSecondAttempt = () => {
      writeFileSync(
        join(capturesDir, "001-submit-real.json"),
        JSON.stringify({
          requestPostData: "type=next&step=review",
          variables: { input: { type: "next" } },
        })
      );
    };
    const originalEvaluate = evaluate.getMockImplementation();
    evaluate.mockImplementation(async (expr: unknown) => {
      const result = await originalEvaluate?.(expr);
      if (String(expr).includes("hasForm") && solveInjectCallCount === 2) {
        writeConfirmingCaptureAfterSecondAttempt();
      }
      return result;
    });

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBe("completed");
    // The fake solveCaptcha/inject expressions ran more than once: two full
    // solve+inject attempts were needed before the registry populated.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(2);
    expect(solveInjectCallCount).toBe(2);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=1/3"));
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=2/3"));
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "registryState=empty callbackDiscovered=true with no confirmed transition on attempt 1; retrying"
      )
    );
  });
});
