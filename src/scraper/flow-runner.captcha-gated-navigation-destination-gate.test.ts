import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-navigation-destination-gate-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-nav-destination-gate-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const NAV_CREDIT_LOG = "post-submit navigation to a new origin/path confirmed the advance";
const BASELINE_URL = "https://shop.example.com/checkout";

function buildParams(
  step: string,
  postSubmitUrl: string
): Parameters<typeof executeStepWithHealing>[0] {
  const page = {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      if (String(expr) === "navigator.userAgent") return "test-agent/1.0";
      return null;
    }),
    frames: vi.fn().mockReturnValue([]),
    mainFrameId: vi.fn().mockReturnValue("main"),
    title: vi.fn().mockResolvedValue(""),
    url: () => BASELINE_URL,
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

  let urlCallCount = 0;
  const captchaTarget: FrameTarget = {
    frame: null,
    frameSelector: "#captcha-frame",
    declaredFrameSelector: "#captcha-frame",
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { injected: true, hasForm: true, callbackDiscovered: false };
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src.includes("requestSubmit")) return undefined;
      return null;
    }) as FrameTarget["evaluate"],
    locator: vi.fn() as unknown as FrameTarget["locator"],
    url: vi.fn().mockImplementation(async () => {
      urlCallCount += 1;
      return urlCallCount === 1 ? BASELINE_URL : postSubmitUrl;
    }),
    title: vi.fn().mockResolvedValue(""),
  };

  return {
    stagehand: {} as Stagehand,
    page,
    frameTarget: captchaTarget,
    step,
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

describe("flow-runner/executeStepWithHealing — captchaGated navigation credit is destination-gated", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("non-sign-in step bouncing to /login is not credited via post-submit navigation", async () => {
    const params = buildParams(
      "Click the Submit Order button",
      "https://shop.example.com/login?redirect=%2Fcheckout"
    );

    const outcome = await executeStepWithHealing(params).then(
      (value) => value,
      () => "rejected"
    );

    expect(outcome).not.toBe("completed");
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining(NAV_CREDIT_LOG));
  }, 60_000);

  it("positive control: a plausible new path is still credited", async () => {
    const params = buildParams(
      "Click the Submit Order button",
      "https://shop.example.com/checkout/confirmation"
    );

    const outcome = await executeStepWithHealing(params);

    expect(outcome).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining(NAV_CREDIT_LOG));
  }, 60_000);
});
