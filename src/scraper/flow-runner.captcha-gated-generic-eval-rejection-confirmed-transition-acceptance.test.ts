import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-gated-generic-eval-rejection-confirmed-transition-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-generic-eval-rejection-confirmed-transition-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Regression guard for the precedence between transition confirmation and
 * the callback-invoke rejection classification: a captchaGated step whose
 * callback-invoke eval rejects with the bare, content-free
 * `StagehandEvalError: Uncaught` message — itself discarded as a tolerable
 * rejection by `isNavigatingEvaluateRejection`, so `injectResult.
 * callbackInvokeError` stays unset — must still resolve `completed` when the
 * transition-body poll independently confirms an advance on the same
 * attempt. The confirmed-transition checks run and can return `completed`
 * BEFORE `injectResult.callbackInvokeError` is ever consulted, so a
 * co-occurring generic rejection must never veto a genuinely detected
 * transition, whether or not the rejection itself carried
 * `callbackInvokeError`.
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

describe("flow-runner/executeStepWithHealing — captchaGated confirmed transition takes precedence over a generic eval-rejection message", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
    (testLogger.error as ReturnType<typeof vi.fn>).mockClear();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("resolves completed and never logs a genuine in-page exception message when a confirmed transition co-occurs with a bare StagehandEvalError rejection", async () => {
    solveCaptchaMock.mockResolvedValueOnce({
      token: "solved-token",
      provider: "2captcha",
      ms: 12,
    });

    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes("found.invoke(token)")) {
        throw new Error("StagehandEvalError: Uncaught");
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      return null;
    });

    const page = {
      evaluate,
      url: () => "https://apply.example.com/application/abc-123",
      title: vi.fn().mockResolvedValue(""),
      locator: vi.fn(),
      waitForTimeout: vi
        .fn()
        .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    } as unknown as Page;
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);
    expect(testLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("genuine in-page exception")
    );
  });
});
