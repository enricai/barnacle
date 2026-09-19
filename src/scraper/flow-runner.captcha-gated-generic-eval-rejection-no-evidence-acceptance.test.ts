import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-gated-generic-eval-rejection-no-evidence-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-generic-eval-rejection-no-evidence-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(
  page: Page,
  stagehand: Stagehand,
  recentCaptureMeta: { method: string; status: number; url: string }[]
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
    recentCaptureMeta,
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

function makePage(evaluate: Page["evaluate"], baselineUrl: string): Page {
  return {
    evaluate,
    url: () => baselineUrl,
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

/**
 * Pins the production shape of a content-free callback-invoke rejection:
 * per node_modules/@browserbasehq/stagehand's page.js/frame.js evaluate
 * wrappers, CDP's exceptionDetails.text is the literal "Uncaught" for both
 * genuine synchronous throws and context-teardown-during-awaitPromise, so
 * toErrorMessage(err) surfaces exactly "StagehandEvalError: Uncaught" with
 * zero further diagnostic content. When no transition detector ever
 * confirms an advance either, the step must still throw a CaptchaError
 * (never silently resolve "completed") but must not assert the specific,
 * unsupported claim that the callback "threw a genuine in-page exception" -
 * it must read like the evidence-based "no confirmed transition" wording
 * already used for the callbackDiscovered=false failure path.
 */
describe("flow-runner/executeStepWithHealing — captchaGated generic content-free eval rejection with no transition evidence (acceptance)", () => {
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

  it("throws a CaptchaError using the no-confirmed-transition wording, never 'genuine in-page exception', when the callback invoke always rejects with only Stagehand's generic content-free wrapper text", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const baselineUrl = "https://apply.example.com/application/abc-123";
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes("found.invoke(token)")) {
        throw new Error("StagehandEvalError: Uncaught");
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      if (src.includes("requestSubmit")) return undefined;
      if (src.includes("fieldForm")) return true;
      if (src.includes("dispatchEvent")) return undefined;
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });

    const page = makePage(evaluate, baselineUrl);
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand, recentCaptureMeta));
    let caught: unknown;
    const assertion = resultPromise.catch((err: unknown) => {
      caught = err;
    });
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    expect(caught).toBeInstanceOf(CaptchaError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("no confirmed transition");
    expect(message).not.toContain("genuine in-page exception");
  }, 30000);
});
