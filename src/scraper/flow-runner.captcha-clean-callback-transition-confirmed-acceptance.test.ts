import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-clean-callback-transition-confirmed-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-clean-callback-transition-confirmed-")
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
    // No matchable XHR body is configured — the site advances via a full-page
    // form submit, so only the post-submit URL/origin poll (never
    // waitForTransitionBody) can ever observe the advance.
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Pins the fix in commit 863cf3e (and the follow-up in bugfix-001): a
 * captchaGated step whose widget callback fires cleanly
 * (callbackDiscovered=true, registryState=populated) but has no named
 * response field (fieldExists=false, hasForm only via the sitekey-anchored
 * form fallback) and no advanceTransitionBodyPattern configured must still
 * have submitCaptchaGatedForm's explicit fallback dispatch a real submit —
 * matching the report's 37/37 reproduction where hasForm resolved true but
 * zero site-host HTTP traffic followed the callback because the pre-fix
 * submit path silently no-opped.
 *
 * The first test below is the load-bearing regression guard for bugfix-001:
 * it proves the fallback issues a real, event-sequence-driven click on the
 * ranked submit-shaped control (mirroring the deep-submit-locator cascade)
 * BEFORE any bare form.requestSubmit()/form.submit() call — the mock never
 * marks the submit as dispatched via the form-level API path, only via the
 * click-activation event sequence, so a regression back to the form-level
 * call alone would leave `clickDispatched` false and fail the assertion.
 */
describe("flow-runner/executeStepWithHealing — captchaGated clean callback confirmed via sitekey-anchored submit fallback (acceptance)", () => {
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

  it("dispatches a real click-sequence submit (not a bare form.requestSubmit()) exactly once and completes on attempt 1 once the post-submit URL/origin change confirms the advance", async () => {
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
      // widget's own render callback fires cleanly (callbackDiscovered=true,
      // registryState=populated below).
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      // submitCaptchaGatedForm's rank pass: reports exactly one submit-shaped
      // candidate (a real button on the page), driving the click-activation
      // path rather than the form-level fallback. Checked before the
      // `getAttribute` branch below since the rank/click expressions also
      // call `getAttribute` internally (accessible-name / type lookups).
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      // submitCaptchaGatedForm's click-by-index pass: this is the ONLY place
      // the test marks the submit as dispatched, and it stands in for the
      // real PointerEvent/MouseEvent gesture + native click() the production
      // expression issues — a regression back to form.requestSubmit() alone
      // would never reach this branch.
      if (src.includes("deepElements") && src.includes("clicked: true")) {
        clickDispatched = true;
        currentUrl = postSubmitUrl;
        return { clicked: true };
      }
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      // submitCaptchaGatedForm's form-level fallback submitExpr — must NEVER
      // fire once the click-activation path above already succeeded.
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

    expect(result).toBe("completed");
    expect(clickDispatched).toBe(true);
    expect(formRequestSubmitDispatched).toBe(false);
    // Single-attempt confirmation, not a retry-driven pass: the widget's
    // clean callback plus the fallback's real click-driven submit must
    // confirm on the very first solve+inject round.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=1/3"));
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("attempt=2/3"));
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("post-submit navigation to a new origin/path confirmed the advance")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("with no confirmed transition on attempt 1; retrying")
    );
  });

  it("falls back to form.requestSubmit() when no submit-shaped click candidate can be found", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    const postSubmitUrl = "https://apply.example.com/application/confirmation";
    let formRequestSubmitDispatched = false;
    let currentUrl = baselineUrl;

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
      }
      if (src.includes('return "absent"')) return "populated";
      // No submit-shaped candidate on this page — the ranking pass returns
      // an empty list, so submitCaptchaGatedForm must fall through to the
      // form-level API rather than silently no-opping. Checked before the
      // `getAttribute` branch below since the rank expression also calls
      // `getAttribute` internally (accessible-name / type lookups).
      if (src.includes("deepElements") && src.includes("ranked.sort")) return [];
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      if (src.includes("requestSubmit")) {
        formRequestSubmitDispatched = true;
        currentUrl = postSubmitUrl;
        return undefined;
      }
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
    expect(formRequestSubmitDispatched).toBe(true);
  });
});
