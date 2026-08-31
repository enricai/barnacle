import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-submit-hook-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-gated-submit-hook-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaSolverUnavailableError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Exercises the captchaGated hook wired into `executeStepWithHealing`: on a
 * submit/final-shaped step marked `captchaGated: true`, it reads the sitekey
 * off the (fake) page, calls the mocked `solveCaptcha`, invokes the real
 * `injectCaptchaTokenAndSubmit` primitive against a fake DOM, and reports
 * completion once the widened `waitForTransitionBody` poll confirms a real
 * transition. A `captchaGated` step with no `[data-sitekey]` widget or with
 * the flag unset falls through untouched; a solver-unavailable rejection
 * fails the step instead of silently passing.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

interface FakeField {
  value: string;
  dispatched: string[];
}

/** Minimal fake `<form>`/hCaptcha-widget DOM + Stagehand `Page`, driven entirely through `page.evaluate`. */
function makeFakePage(opts: { hasSitekey: boolean }): {
  page: Page;
  field: FakeField;
  submitCount: { n: number };
} {
  const field: FakeField = { value: "", dispatched: [] };
  const submitCount = { n: 0 };

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    // Checked BEFORE the sitekey-probe branch: injectCaptchaTokenAndSubmit's
    // real expression string always contains "data-sitekey" too (its
    // create-missing-field fallback references the same anchor selector), so
    // matching on "responseField" first disambiguates it from the probe expr.
    if (src.includes("responseField")) {
      // injectCaptchaTokenAndSubmit's inline expression — run against a bare fake
      // DOM instead of re-deriving the exact expr string (mirrors
      // flow-runner.captcha-inject-submit.test.ts's technique, simplified since
      // that primitive already has its own dedicated unit tests).
      field.value = "solved-token";
      field.dispatched.push("change");
      submitCount.n += 1;
      return { injected: true, submitted: true };
    }
    if (src.includes("data-sitekey")) {
      return opts.hasSitekey
        ? { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true }
        : { siteKey: null, isInvisible: false };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
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
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  return { page, field, submitCount };
}

function baseParams(
  page: Page,
  stagehand: Stagehand,
  overrides: { captchaGated: boolean; advanceTransitionBodyPattern: string | null }
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Solve the captcha and submit the application",
    optional: false,
    upload: false,
    submitStep: true,
    captchaGated: overrides.captchaGated,
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
    advanceTransitionBodyPattern: overrides.advanceTransitionBodyPattern,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — captcha-gated submit hook", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("solves, injects the token, submits, and reports completed once the widened poll confirms the real transition already on disk", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    // Written BEFORE the hook runs, so waitForTransitionBody's initial
    // (non-polling) check already matches it — proves the hook reuses the
    // EXISTING poll primitive rather than a new captcha-specific one, without
    // this test paying the real wall-clock cost of the widened budget.
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    );

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledWith({
      type: "hcaptcha",
      siteKey: "10000000-ffff-ffff-ffff-000000000001",
      pageUrl: "https://apply.example.com/application/abc-123",
      isInvisible: true,
      userAgent: "test-agent/1.0",
    });
    expect(field.value).toBe("solved-token");
    expect(field.dispatched).toEqual(["change"]);
    expect(submitCount.n).toBe(1);
  });

  it("falls through untouched (no solve call) when captchaGated is unset", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, submitCount } = makeFakePage({ hasSitekey: true });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, {
        captchaGated: false,
        advanceTransitionBodyPattern: "type=next",
      })
    ).catch(() => {
      // Falling through into the full cascade on this bare fake page/stagehand
      // is expected to eventually throw — only "the hook itself never ran" is
      // under test here.
    });

    expect(solveCaptchaMock).not.toHaveBeenCalled();
    expect(submitCount.n).toBe(0);
  });

  it("falls through untouched (no solve call) when the page has no [data-sitekey] widget", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, submitCount } = makeFakePage({ hasSitekey: false });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    ).catch(() => {
      // Same rationale as above: cascade fallthrough is expected to fail on
      // this bare fake; only the "no sitekey => no solve call" gate is under test.
    });

    expect(solveCaptchaMock).not.toHaveBeenCalled();
    expect(submitCount.n).toBe(0);
  });

  it("fails the step (never silently proceeds) when solveCaptcha rejects with the unavailable error", async () => {
    solveCaptchaMock.mockRejectedValue(new CaptchaSolverUnavailableError());
    const { page, submitCount } = makeFakePage({ hasSitekey: true });
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, {
          captchaGated: true,
          advanceTransitionBodyPattern: "type=next",
        })
      )
    ).rejects.toThrow(CaptchaSolverUnavailableError);

    expect(submitCount.n).toBe(0);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: solve failed")
    );
  });
});
