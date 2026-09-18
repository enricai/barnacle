import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-gated-network-transition-confirms-clean-callback-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-network-transition-confirms-clean-callback-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

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
    // No matchable XHR body is configured — this pins the ONLY signature
    // where the sole surviving detector besides waitForCaptchaNavigation's
    // URL/origin poll is the network-capture transition check.
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Pins the network-signal confirmation gap identified in
 * recon-piedmont-captchagated-no-confirmed-transition-despite-clean-callback.md:
 * a clean callback (callbackDiscovered=true, registryState=populated) whose
 * fallback-dispatched submit produces an observable, captured non-GET 2xx/3xx
 * response is a real advance even when the page's URL/origin never changes
 * (an XHR/fetch-driven submit with no client-side redirect). Before this fix
 * the attempt loop only ever consulted waitForTransitionBody (gated on
 * advanceTransitionBodyPattern, unset here) and waitForCaptchaNavigation (a
 * pure URL/origin comparator) — neither of which can observe a same-origin,
 * same-path network response — so the step exhausted all 3 attempts and
 * threw instead of completing on attempt 1.
 */
describe("flow-runner/executeStepWithHealing — captchaGated clean callback confirmed via network transition with no URL/origin change (acceptance)", () => {
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

  it("completes on attempt 1 via the captured network transition when the fallback submit's response never changes the page URL/origin", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    let clickDispatched = false;
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      // The widget's own render callback fires cleanly (callbackDiscovered
      // =true), and only the sitekey-anchored form fallback is found
      // (fieldExists=false, hasForm=true).
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      // The explicit fallback click dispatches a real, same-origin XHR/fetch
      // submit — the response lands in recentCaptureMeta, but the page's
      // URL/origin never changes (no client-side redirect).
      if (src.includes("deepElements") && src.includes("clicked: true")) {
        clickDispatched = true;
        recentCaptureMeta.push({
          method: "POST",
          status: 200,
          url: "https://apply.example.com/api/application/submit",
        });
        return { clicked: true };
      }
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

    const page = {
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
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand, recentCaptureMeta));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toBe("completed");
    expect(clickDispatched).toBe(true);
    // Single-attempt confirmation via the network signal, not a retry-
    // driven pass and not the URL/origin poll (the URL never changed).
    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=1/3"));
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("attempt=2/3"));
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("post-submit network response confirmed the advance")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("post-submit navigation to a new origin/path confirmed the advance")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("with no confirmed transition on attempt 1; retrying")
    );
  });
});
