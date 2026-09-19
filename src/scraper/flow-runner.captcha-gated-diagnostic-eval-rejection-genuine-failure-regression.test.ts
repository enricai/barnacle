import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-gated-diagnostic-eval-rejection-genuine-failure-regression-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-diagnostic-eval-rejection-genuine-failure-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Anti-regression boundary for the content-free `StagehandEvalError`
 * tolerance: a rejection whose message carries Stagehand's wrapper prefix
 * PLUS real diagnostic detail ("StagehandEvalError: TypeError: widget.
 * callback is not a function") must still be classified as a genuine
 * in-page exception, never discarded as if it were the content-free
 * "Uncaught"/"Evaluation failed" shape. A fix that matches by a bare
 * substring like "uncaught" rather than exact membership in the
 * content-free set would wrongly swallow this and reintroduce the
 * pre-1.12.55 phantom-completion regression.
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

/**
 * A clean-callback page whose precheck discovers a `data-callback` widget,
 * but whose callback-invoke eval always rejects with Stagehand's wrapper
 * prefix carrying real diagnostic detail past it — never a bare
 * content-free classification string, and never any site-host traffic.
 */
function makeDiagnosticRejectionCallbackPage(): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { fieldExists: false, hasForm: true, callbackDiscovered: true };
    }
    if (src.includes("found.invoke(token)")) {
      throw new Error("StagehandEvalError: TypeError: widget.callback is not a function");
    }
    if (src.includes('return "absent"')) return "populated";
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

  return {
    evaluate,
    url: () => "https://apply.example.com/application/abc-123",
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
}

describe("flow-runner/executeStepWithHealing — captchaGated diagnostic-eval-rejection genuine-failure regression", () => {
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

  it("never tolerates a Stagehand-wrapped rejection that carries real diagnostic detail beyond the generic wrapper text — retries, then fails with a CaptchaError naming the real cause", async () => {
    solveCaptchaMock
      .mockResolvedValueOnce({ token: "solved-token-1", provider: "2captcha", ms: 12 })
      .mockResolvedValueOnce({ token: "solved-token-2", provider: "2captcha", ms: 12 })
      .mockResolvedValueOnce({ token: "solved-token-3", provider: "2captcha", ms: 12 });

    const page = makeDiagnosticRejectionCallbackPage();
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand)).catch(
      (err: unknown) => err
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    // Must never silently report a completed transition — a substring match
    // on "uncaught" would wrongly discard this diagnostic-carrying rejection.
    expect(result).not.toBe("completed");
    expect(result).toBeInstanceOf(CaptchaError);
    expect((result as Error).message).toContain(
      "the discovered callback threw a genuine in-page exception"
    );
    expect((result as Error).message).toContain(
      "StagehandEvalError: TypeError: widget.callback is not a function"
    );

    // The diagnostic-carrying rejection must be traced through every retry,
    // not silently discarded on attempts 1 and 2.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(3);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "the discovered callback threw a genuine in-page exception on attempt 1/3"
      )
    );
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "the discovered callback threw a genuine in-page exception on attempt 2/3"
      )
    );
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "the discovered callback threw a genuine in-page exception on attempt 3/3"
      )
    );
  });
});
