import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-callback-invoke-exception-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-callback-invoke-exception-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Reproduces the reported signature: a captchaGated step whose solve+inject
 * cleanly discovers a callback (`callbackDiscovered: true`, `hasForm: true`)
 * but whose callback-invoke eval throws a genuine in-page exception — a
 * `TypeError` inside the widget's own callback, not a navigating-evaluate's
 * expected context-teardown rejection. Before this fix, `.catch(() =>
 * undefined)` swallowed that exception indistinguishably from a legitimate
 * navigation, so the step silently fell through to the phantom-click cascade
 * with `callbackDiscovered=true`/`injected=true` logged and zero site-host
 * traffic ever dispatched. It must now either retry (recording the swallowed
 * exception) or fail loudly with a `CaptchaError` naming the real cause.
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
 * A clean-callback page whose precheck discovers a `data-callback` widget
 * (`hasForm: true`, `callbackDiscovered: true`), but whose callback-invoke
 * eval throws a real `TypeError` every time — never a navigating-evaluate
 * context-teardown rejection, and never any site-host traffic.
 */
function makeThrowingCallbackPage(): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { fieldExists: false, hasForm: true, callbackDiscovered: true };
    }
    if (src.includes("found.invoke(token)")) {
      throw new TypeError("Cannot read properties of undefined (reading 'append')");
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

describe("flow-runner/executeStepWithHealing — captchaGated clean-callback swallowed-exception regression", () => {
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

  it("never reports a silent completion when the discovered callback genuinely throws — retries, then fails with a CaptchaError naming the real cause", async () => {
    solveCaptchaMock
      .mockResolvedValueOnce({ token: "solved-token-1", provider: "2captcha", ms: 12 })
      .mockResolvedValueOnce({ token: "solved-token-2", provider: "2captcha", ms: 12 })
      .mockResolvedValueOnce({ token: "solved-token-3", provider: "2captcha", ms: 12 });

    const page = makeThrowingCallbackPage();
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand)).catch(
      (err: unknown) => err
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    // Must never silently report a completed transition — the whole point of
    // the fix is that this must be diagnosable, not a phantom "completed".
    expect(result).not.toBe("completed");
    expect(result).toBeInstanceOf(CaptchaError);
    expect((result as Error).message).toContain(
      "the discovered callback threw a genuine in-page exception"
    );
    expect((result as Error).message).toContain(
      "Cannot read properties of undefined (reading 'append')"
    );

    // The swallowed exception must be traced through the retries, not
    // silently discarded on attempts 1 and 2.
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

  it("still tolerates a legitimate navigating-evaluate rejection from the same callback-invoke eval and reaches a confirmed completion", async () => {
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
        throw new Error("Execution context was destroyed");
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
      url: () => "https://apply.example.com/application/thank-you",
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
