import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-late-install-after-render-recovery-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-late-install-after-render-recovery-acceptance-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Acceptance-tests the reported symptom end to end: a captcha whose render
 * fires before the callback-capture wrap has landed for this attempt still
 * recovers, because the loop re-asserts the wrap install on the next
 * attempt before that widget's render can fire — closing the reported
 * silent race, distinct from the already-fixed "main world not ready"
 * error case and distinct from the renderedUnmatched give-up case, where
 * the render call has already returned before any reinstall could occur.
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
    step: "Solve the captcha and submit the form",
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

/**
 * Fake page evaluate mirroring flow-runner.captcha-registry-retry-acceptance.test.ts:
 * the injectCaptchaTokenAndSubmit precheck is keyed on "hasForm", its
 * callback-discovery fallback lookup on "Boolean(__findCaptchaCallback"
 * (checked before the generic sitekey-read "getAttribute" marker), and the
 * registry-state probe on 'return "absent"'. On attempt 1 the widget's
 * render has not fired yet (the reported symptom's timing), so the wrap
 * installed at solve-start still finds an empty registry; the reinstall at
 * the top of attempt 2 lands before this attempt's render, so by the time
 * attempt 2's probe runs the registry has captured the callback.
 */
function makeEvaluate(registryStateForAttempt: (attempt: number) => "empty" | "populated") {
  let solveInjectCallCount = 0;
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      solveInjectCallCount += 1;
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes("Boolean(__findCaptchaCallback")) return false;
    if (src.includes('return "absent"')) return registryStateForAttempt(solveInjectCallCount);
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
  return { evaluate, getCallCount: () => solveInjectCallCount };
}

function makeFakePage(evaluate: Page["evaluate"]): Page {
  return {
    evaluate,
    url: () => "https://apply.example.com/form/abc-123",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    // Real setTimeout-backed waitForTimeout so `vi.runAllTimersAsync()` can
    // drive the CAPTCHA_TRANSITION_POLL_MS interval loop within each attempt
    // to its unconfirmed end before a retry kicks in.
    waitForTimeout: vi
      .fn()
      .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  } as unknown as Page;
}

describe("flow-runner/executeStepWithHealing — captchaGated late-install-after-render recovery (acceptance)", () => {
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

  it("recovers from render-fires-before-wrap-lands on attempt 1 by re-asserting the install before attempt 2's render", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { evaluate, getCallCount } = makeEvaluate((attempt) =>
      attempt >= 2 ? "populated" : "empty"
    );

    // Only visible once the second solve+inject attempt has run, so
    // attempt 1's waitForTransitionBody check can never see it — the
    // confirmed transition can only come from attempt 2, once the
    // reinstalled wrap has caught this attempt's render call.
    const writeConfirmingCaptureAfterSecondAttempt = () => {
      writeFileSync(
        join(capturesDir, "001-submit-real.json"),
        JSON.stringify({
          requestPostData: "type=next&step=review",
          variables: { input: { type: "next" } },
        })
      );
    };
    const originalImpl = evaluate.getMockImplementation();
    evaluate.mockImplementation(async (expr: unknown) => {
      const result = await originalImpl?.(expr);
      if (String(expr).includes("hasForm") && getCallCount() === 2) {
        writeConfirmingCaptureAfterSecondAttempt();
      }
      return result;
    });

    const page = makeFakePage(evaluate);
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBe("completed");
    // The retry loop stayed within CAPTCHA_REGISTRY_RETRY_ATTEMPTS=3: two
    // solve+inject rounds were enough once the reinstall on attempt 2 beat
    // that attempt's render, rather than exhausting the budget or throwing.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(2);
    expect(getCallCount()).toBe(2);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=1/3"));
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=2/3"));
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "registryState=empty callbackDiscovered=false with no confirmed transition on attempt 1; retrying"
      )
    );
  });
});
