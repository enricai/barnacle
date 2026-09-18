import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-solve-timeout-continues-despite-disabled-candidate-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-solve-timeout-continues-despite-disabled-candidate-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Combines Root Cause A's disabled-submit-candidate veto (pinned by
 * flow-runner.captcha-gated-disabled-candidate-recovery-acceptance.test.ts)
 * with the already-fixed Signature D mid-retry 2Captcha poll-timeout
 * tolerance (flow-runner.captcha-solve-timeout-continues-retry-acceptance.test.ts):
 * attempt 1's clean callback fires against a sole candidate that races into
 * a disabled state (no confirmed transition, so shouldRetryCaptchaRegistry
 * retries per callbackDiscovered && !confirmed), then attempt 2's
 * `solveCaptcha` itself rejects with the 2Captcha poll-timeout error. The
 * loop must still proceed to attempt 3 rather than hard-aborting the run —
 * pinning Signature D under this stuck-step shape, not just the plain
 * success-then-timeout shape the existing pattern covers.
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
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — captchaGated 2Captcha poll timeout continues past a disabled-candidate attempt (acceptance)", () => {
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

  it("attempt 1's disabled-candidate no-confirm retry survives attempt 2's solve-provider timeout and reaches attempt 3", async () => {
    // Attempt 1: solveCaptcha resolves, but the sole ranked submit candidate
    // races into a disabled state and the form-level fallback never confirms
    // a transition, so shouldRetryCaptchaRegistry retries.
    // Attempt 2: solveCaptcha itself rejects with the 2Captcha poll-timeout
    // error (Signature D).
    // Attempt 3: solveCaptcha resolves and an enabled candidate confirms via
    // a post-submit navigation.
    solveCaptchaMock
      .mockResolvedValueOnce({ token: "solved-token", provider: "2captcha", ms: 12 })
      .mockRejectedValueOnce(new CaptchaError("2captcha task not ready yet"))
      .mockResolvedValueOnce({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    const postSubmitUrl = "https://apply.example.com/application/confirmation";
    let currentUrl = baselineUrl;
    let solvedInjectAttempt = 0;

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      // Both attempts' precheck report the same clean-callback shape: a
      // sitekey-anchored form exists (fieldExists=false, hasForm=true via
      // the fallback path) and the widget's own render callback fires
      // cleanly.
      if (src.includes("hasForm")) {
        solvedInjectAttempt += 1;
        return { fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      // submitCaptchaGatedForm's findFormExpr: a sitekey-anchored form
      // exists to submit.
      if (src.includes("fieldForm")) return true;
      // submitCaptchaGatedForm's rank pass: exactly one submit-shaped
      // candidate, both attempts.
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      // submitCaptchaGatedForm's click-by-index pass: attempt 1's candidate
      // races into disabled between rank and click (Root Cause A); attempt
      // 3's candidate is enabled and lands the click, which drives the
      // post-submit navigation below.
      if (src.includes("deepElements") && src.includes("clicked: true")) {
        if (solvedInjectAttempt < 2) {
          return { clicked: false, reason: "not-actionable" };
        }
        currentUrl = postSubmitUrl;
        return { clicked: true };
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
      url: () => currentUrl,
      title: vi.fn().mockResolvedValue(""),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
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
    expect(solveCaptchaMock).toHaveBeenCalledTimes(3);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("with no confirmed transition on attempt 1; retrying")
    );
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("solve failed on attempt 2/3 (2captcha task not ready yet); retrying")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("post-submit navigation to a new origin/path confirmed the advance")
    );
  });
});
