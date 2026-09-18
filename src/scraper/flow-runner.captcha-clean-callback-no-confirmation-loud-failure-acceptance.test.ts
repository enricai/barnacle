import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-clean-callback-no-confirmation-loud-failure-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-clean-callback-no-confirmation-loud-failure-")
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
    // No pattern is configured at all — the ONLY signature this test pins:
    // a clean callback with neither the navigation poll nor the
    // network-capture scan ever confirming an advance, on every attempt.
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Pins the recon report's Evidence-section gap: a captchaGated step whose
 * callback is cleanly discovered and invoked on EVERY attempt
 * (callbackDiscovered=true, registryState=populated), with no
 * advanceTransitionBodyPattern configured and neither
 * waitForCaptchaNavigation (URL/origin poll) nor findRecentPageTransition
 * (network-capture scan) ever confirming an advance, must fail loudly
 * instead of silently `break`-ing out of the captchaGated block into the
 * normal phantom-click cascade as if the solve had worked. The only
 * existing loud-failure guard (`advanceTransitionBodyPattern &&
 * !injectResult.callbackDiscovered`) is false on both operands for this
 * exact shape, so a reverted/unfixed run falls through silently instead of
 * throwing.
 */
describe("flow-runner/executeStepWithHealing — captchaGated clean callback with zero confirmed transition across all attempts (acceptance)", () => {
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

  it("rejects with a thrown diagnostic attributed to the captchaGated hook after exhausting all attempts, never resolving 'completed'", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    // Never pushed to on any attempt: no network-captured response and no
    // URL/origin change, so neither transition detector can ever confirm.
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      // The widget's own render callback fires cleanly on EVERY attempt
      // (callbackDiscovered=true), and only the sitekey-anchored form
      // fallback is found (fieldExists=false, hasForm=true).
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      // The explicit fallback click dispatches, but deliberately never
      // produces an observable capture — no response ever lands in
      // recentCaptureMeta on any attempt.
      if (src.includes("deepElements") && src.includes("clicked: true")) {
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
      // Never changes across any attempt: waitForCaptchaNavigation's
      // origin/path comparator can never confirm the advance.
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
    const assertion = expect(resultPromise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    // All 3 attempts ran, and the callback was cleanly discovered on every
    // single one — this is not a registry race or a solve failure.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(3);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=3/3"));
    const infoLines = (testLogger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(infoLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("callbackDiscovered=true registryState=populated"),
      ])
    );
    // Never confirmed via either transition detector, on any attempt.
    expect(infoLines).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("post-submit navigation to a new origin/path confirmed"),
      ])
    );
    expect(infoLines).not.toEqual(
      expect.arrayContaining([expect.stringContaining("post-submit network response confirmed")])
    );
    // Failure must be attributed to the captchaGated hook itself, not to a
    // generic downstream cascade failure it silently fell through into.
    const errorLines = (testLogger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(errorLines.some((l) => l.includes("captchaGated step:"))).toBe(true);
  });
});
