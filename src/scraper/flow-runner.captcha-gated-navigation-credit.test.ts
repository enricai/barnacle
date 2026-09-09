import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-navigation-credit-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-gated-navigation-credit-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing, hasOriginOrPathChanged } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

describe("hasOriginOrPathChanged", () => {
  it("returns false when the URL is unchanged", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://example.com/checkout")
    ).toBe(false);
  });

  it("returns false for a same-origin, same-path change limited to the query string", () => {
    expect(
      hasOriginOrPathChanged(
        "https://example.com/checkout?step=1",
        "https://example.com/checkout?step=2"
      )
    ).toBe(false);
  });

  it("returns true when the path changed on the same origin", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://example.com/checkout/confirm")
    ).toBe(true);
  });

  it("returns true when the origin changed", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://secure.example.com/checkout")
    ).toBe(true);
  });
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(
  page: Page,
  stagehand: Stagehand,
  frameTarget: FrameTarget
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    frameTarget,
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
    // Not configured for this widget — the site advances via a full-page
    // form submit with no matchable XHR body, so only waitForCaptchaNavigation
    // (not waitForTransitionBody) can ever observe the advance.
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Reproduces the reported bug: `waitForCaptchaNavigation` reads
 * `captchaTarget.url()` and, on rejection, historically fell back to
 * `baselineUrl` — treating "I couldn't read this frame's URL" as "this
 * frame's URL hasn't changed". That is exactly backwards whenever the
 * frame handle went stale BECAUSE the frame navigated (an in-iframe
 * navigation detaches the old `Frame` object Stagehand's CDP layer bound
 * `captchaTarget` to). The fix routes this read through
 * `readCurrentFrameUrl`, which re-resolves the declared frame selector
 * against `page.frames()` instead of masking the stale read as
 * "unchanged".
 */
describe("flow-runner/executeStepWithHealing — captchaGated navigation credit survives a stale frame handle", () => {
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

  it("credits the advance on the first attempt when the captcha target's frame goes stale mid-submit but re-resolves to a frame at a new path", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const frameSelector = "#captcha-frame";
    const baselineFrameUrl = "https://frame.example.com/widget";
    const postSubmitFrameUrl = "https://frame.example.com/step2";

    const postSubmitFrame = {
      frameId: "child-post-submit",
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (String(expr) === "location.href") return postSubmitFrameUrl;
        return null;
      }),
      locator: vi.fn(),
    } as unknown as ReturnType<Page["frames"]>[number];

    const page = {
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        const src = String(expr);
        // tryResolveChildFrame's iframe-src probe, run when readCurrentFrameUrl
        // re-resolves the declared frame selector after captchaTarget.url() rejects.
        if (src.includes("IFRAME")) {
          return { matched: true, src: postSubmitFrameUrl };
        }
        if (src === "navigator.userAgent") return "test-agent/1.0";
        return null;
      }),
      frames: vi.fn().mockReturnValue([postSubmitFrame]),
      mainFrameId: vi.fn().mockReturnValue("main"),
      title: vi.fn().mockResolvedValue(""),
      url: () => baselineFrameUrl,
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

    // `captchaTarget.url()` succeeds exactly once (the baseline read before
    // solve/submit), then rejects on every later call — modeling the frame
    // handle going stale as a direct result of the in-frame navigation the
    // submit triggered, not an unrelated read failure.
    let urlCallCount = 0;
    const captchaTarget: FrameTarget = {
      frame: null,
      frameSelector,
      declaredFrameSelector: frameSelector,
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
      url: vi.fn().mockImplementation(() => {
        urlCallCount += 1;
        return urlCallCount === 1
          ? Promise.resolve(baselineFrameUrl)
          : Promise.reject(new Error("frame detached: in-frame navigation tore down the context"));
      }),
      title: vi.fn().mockResolvedValue(""),
    };

    const result = await executeStepWithHealing(baseParams(page, stagehand, captchaTarget));

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("post-submit navigation to a new origin/path confirmed the advance")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("attempt=2/3"));
  });
});
