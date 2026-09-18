import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID =
  "flow-runner-captcha-pattern-configured-no-callback-loud-failure-regression-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-pattern-configured-no-callback-loud-failure-")
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
    // The pre-existing narrow throw condition this test pins: a pattern IS
    // configured, but no render-config callback is EVER discoverable on any
    // attempt, so neither transition detector has anything to confirm.
    advanceTransitionBodyPattern: '"status":"submitted"',
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

/**
 * Regression guard for the pre-existing, narrower throw condition (pattern
 * configured + callback never discoverable at all), which must keep throwing
 * with its original message shape after test-001's fix broadens the guard
 * to also cover the "pattern absent, clean callback, never confirmed" shape.
 * A fix that collapses both conditions into one, or that narrows the
 * existing guard while widening it, would silently break this pre-existing
 * behavior.
 */
describe("flow-runner/executeStepWithHealing — advanceTransitionBodyPattern configured with no discoverable callback ever (regression)", () => {
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

  it("still rejects with the pre-existing 'no render-config callback could be found and delivered' CaptchaError message", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });

    const baselineUrl = "https://apply.example.com/application/abc-123";
    // Never pushed to on any attempt: no network-captured response, so the
    // pattern poll never confirms a transition either.
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      // No render-config callback is EVER discovered, and no fallback form
      // is found to explicitly submit — this is the pre-existing narrow
      // throw condition, distinct from test-001's clean-callback shape.
      if (src.includes("hasForm")) {
        return { injected: true, fieldExists: false, hasForm: false, callbackDiscovered: false };
      }
      if (src.includes('return "absent"')) return "empty";
      if (src.includes("deepElements") && src.includes("ranked.sort")) {
        return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
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
    const assertion = expect(resultPromise).rejects.toThrow(
      "no render-config callback could be found and delivered, and no transition was confirmed after the solve"
    );
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    // All 3 attempts ran, and the callback was never discovered on any of
    // them — this is the pre-existing loud-failure branch, not a registry
    // race that eventually resolved.
    expect(solveCaptchaMock).toHaveBeenCalledTimes(3);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("attempt=3/3"));
    const infoLines = (testLogger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(infoLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("callbackDiscovered=false registryState=empty"),
      ])
    );
    expect(infoLines).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("post-submit navigation to a new origin/path confirmed"),
      ])
    );
    expect(infoLines).not.toEqual(
      expect.arrayContaining([expect.stringContaining("post-submit network response confirmed")])
    );
  });
});
