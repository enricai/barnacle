import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-solve-timeout-retry-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-solve-timeout-retry-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Exercises the distinct solve-timeout failure axis at the solveCaptcha
 * .catch site (as opposed to registry-state races, already covered by
 * flow-runner.captcha-registry-retry.test.ts): a transient 2captcha
 * "task not ready yet" rejection on an attempt strictly under
 * CAPTCHA_REGISTRY_RETRY_ATTEMPTS must be retried within budget, and only a
 * rejection on the final attempt should surface as a thrown error.
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

function makeSuccessfulPage(capturesDir: string): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
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

  writeFileSync(
    join(capturesDir, "001-submit-real.json"),
    JSON.stringify({
      requestPostData: "type=next&step=review",
      variables: { input: { type: "next" } },
    })
  );

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

describe("flow-runner/executeStepWithHealing — captchaGated solve-timeout bounded retry", () => {
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

  it("retries a solve rejection on attempt 1 and completes once attempt 2's solve resolves and the transition confirms", async () => {
    solveCaptchaMock
      .mockRejectedValueOnce(new CaptchaError("2captcha task not ready yet"))
      .mockResolvedValueOnce({ token: "solved-token", provider: "2captcha", ms: 12 });

    const page = makeSuccessfulPage(capturesDir);
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledTimes(2);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("solve failed on attempt 1/3 (2captcha task not ready yet); retrying")
    );
  });

  it("throws when the solve rejects on the final attempt (3/3), preserving today's terminal-failure behavior", async () => {
    solveCaptchaMock
      .mockRejectedValueOnce(new CaptchaError("2captcha task not ready yet"))
      .mockRejectedValueOnce(new CaptchaError("2captcha task not ready yet"))
      .mockRejectedValueOnce(new CaptchaError("2captcha task not ready yet"));

    const page = makeSuccessfulPage(capturesDir);
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand)).catch(
      (err: unknown) => err
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBeInstanceOf(CaptchaError);
    expect((result as Error).message).toBe("2captcha task not ready yet");
    expect(solveCaptchaMock).toHaveBeenCalledTimes(3);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "solve failed on attempt 3/3 (2captcha task not ready yet); failing the step rather than silently proceeding"
      )
    );
  });
});
