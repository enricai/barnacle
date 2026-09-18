import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-disabled-candidate-recovery-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-gated-disabled-candidate-recovery-")
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
    // No matchable XHR body is configured — matches the report's real seed
    // shape, so only the post-submit URL/origin poll can ever observe the
    // advance.
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Pins Root Cause A directly at the `executeStepWithHealing` level (the
 * caller `submitCaptchaGatedForm` reports back to), once the disabled/
 * aria-disabled veto in `buildRankSubmitCandidatesExpr`/
 * `buildClickByDeepIndexExpr` (commit 024036f, pinned unit-level by
 * `flow-runner.captcha-gated-disabled-submit-candidate-acceptance.test.ts`)
 * has landed: a clean captcha callback fire (callbackDiscovered=true,
 * registryState=populated) whose sole ranked submit candidate turns out to
 * be not-actionable (disabled between rank and click, per
 * `buildClickByDeepIndexExpr`'s own race-window contract) must NEVER be
 * reported as a false-positive `clicked: true`, and the fallback must still
 * land a confirmed transition via the form-level submit dispatch — not fall
 * through to the phantom-click cascade with zero site-host traffic, matching
 * the report's required outcome.
 */
describe("flow-runner/executeStepWithHealing — captchaGated clean callback recovers from a not-actionable top-ranked submit candidate (acceptance)", () => {
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

  it("never reports the not-actionable candidate as clicked, dispatches the form-level fallback instead, and completes via a confirmed post-submit URL/origin change", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    const postSubmitUrl = "https://apply.example.com/application/confirmation";
    let clickDispatched = false;
    let formRequestSubmitDispatched = false;
    let currentUrl = baselineUrl;

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      // The named response field never exists — only the sitekey-anchored
      // form is found (hasForm=true via the fallback path), and the
      // widget's own render callback fires cleanly.
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      // submitCaptchaGatedForm's rank pass: reports exactly one submit-shaped
      // candidate — this stands in for a candidate that raced into a
      // disabled state between the rank and click round trips, which is the
      // only way `buildClickByDeepIndexExpr` itself reports not-actionable
      // (the rank pass already filters disabled/aria-disabled candidates out
      // of what it returns). Checked before the `getAttribute` branch below
      // since the rank/click expressions also call `getAttribute`
      // internally (accessible-name / type lookups).
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      // submitCaptchaGatedForm's click-by-index pass: the candidate is
      // disabled by the time the click round trip fires, so the real
      // generated expression's own not-actionable branch is what a
      // regression-free implementation reports — never a phantom
      // `clicked: true`.
      if (src.includes("deepElements") && src.includes("clicked: true")) {
        clickDispatched = true;
        return { clicked: false, reason: "not-actionable" };
      }
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      // submitCaptchaGatedForm's form-level fallback submitExpr — the ONLY
      // place this test marks a real transition as dispatched, since the
      // click-by-index pass above never earns success.
      if (src.includes("requestSubmit")) {
        formRequestSubmitDispatched = true;
        currentUrl = postSubmitUrl;
        return undefined;
      }
      // submitCaptchaGatedForm's findFormExpr: no named response field, but a
      // sitekey-anchored form exists to submit.
      if (src.includes("fieldForm")) return true;
      if (src.includes("dispatchEvent")) return undefined;
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });

    const page = {
      evaluate,
      url: () => currentUrl,
      title: vi.fn().mockResolvedValue(""),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      // Real setTimeout-backed waitForTimeout so `vi.runAllTimersAsync()` can
      // drive the poll window without real waiting.
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

    // The not-actionable candidate must never earn credit for a submit —
    // the fallback's form-level dispatch is what confirms the advance.
    expect(clickDispatched).toBe(true);
    expect(formRequestSubmitDispatched).toBe(true);
    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("post-submit navigation to a new origin/path confirmed the advance")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("with no confirmed transition on attempt 1; retrying")
    );
  });
});
