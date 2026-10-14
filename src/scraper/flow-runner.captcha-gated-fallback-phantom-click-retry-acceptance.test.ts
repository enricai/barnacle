import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-fallback-phantom-click-retry-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-gated-fallback-phantom-click-retry-acceptance-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import type { AttemptRecord } from "@/scraper/flow-runner";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001's fix at the acceptance level, driven through the real
 * `executeStepWithHealing` (mirrors
 * flow-runner.captcha-gated-submit-navigation-credit-acceptance.test.ts's
 * harness): the explicit-submit fallback's ranked top pick accepts a
 * synthetic click (`clicked: true`) but wires no real handler — a phantom
 * click, per `classifyPhantomClick` in `src/scraper/phantom-click.ts` — while
 * a ranked runner-up candidate is real and actually advances the page. Before
 * bugfix-001, the top pick's bare `clicked: true` alone credited the step; a
 * regression to that would leave this step stuck reporting a completed
 * submit that never advanced the page.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const REVIEW_URL = "https://forms.example.com/apply/review";
const CONFIRMATION_URL = "https://forms.example.com/apply/confirmation";
const SWAPPED_TEXT_LENGTH = 400;

/**
 * Fake application-form DOM + Stagehand `Page`. The rank-submit-candidates
 * eval always reports two candidates (top pick + runner-up); the
 * click-by-deep-index eval marks whichever index was clicked but only the
 * runner-up (deepIndex 1) flips `page.url()` — the top pick (deepIndex 0)
 * is a phantom: it reports `clicked: true` with zero observable effect.
 */
function makeFakePage(options: { topPickSwapsText?: boolean } = {}): {
  page: Page;
  runnerUpClicked: { n: number };
  clicks: number[];
} {
  const runnerUpClicked = { n: 0 };
  const clicks: number[] = [];
  const textSwapped = { value: false };

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes('return "absent"')) return "absent";
    if (src.includes("sitekeyForm") && src.includes("closest")) return true;
    if (src.includes("REGISTRY_KEY")) return undefined;
    if (src.includes("deepElements") && src.includes("ranked.sort")) {
      return [
        { deepIndex: 0, tier: 3, tag: "button", accessibleName: "Submit" },
        { deepIndex: 1, tier: 2, tag: "div", accessibleName: "Submit Application" },
      ];
    }
    if (src.includes("deepElements") && src.includes("clicked: true")) {
      const isRunnerUp = src.includes("all[1]");
      clicks.push(isRunnerUp ? 1 : 0);
      if (isRunnerUp) runnerUpClicked.n += 1;
      else if (options.topPickSwapsText) textSwapped.value = true;
      return { clicked: true };
    }
    if (src.includes("b.outerHTML"))
      return textSwapped.value
        ? { html: 0, text: `${SWAPPED_TEXT_LENGTH}:Thanks for registering` }
        : { html: 0, text: "0:" };
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  const page = {
    evaluate,
    url: () => (runnerUpClicked.n > 0 ? CONFIRMATION_URL : REVIEW_URL),
    title: vi.fn().mockResolvedValue(""),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  return { page, runnerUpClicked, clicks };
}

/**
 * Stagehand whose `act()` resolves nothing (the "unresolved" verdict), which
 * escalates a submit-shaped step straight to the deep-submit-locator rather
 * than the captcha-gated fallback.
 */
function makeUnresolvedStagehand(): Stagehand {
  return {
    act: vi.fn().mockResolvedValue({
      success: false,
      message: "no actionable element found",
      actionDescription: "could not resolve Register",
      actions: [{ selector: "button#register", description: "Register", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockResolvedValue([
        { selector: "button#register", description: "Register", method: "click" },
      ]),
  } as unknown as Stagehand;
}

function baseParams(
  page: Page,
  stagehand: Stagehand,
  trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"]; targetId?: string }[]
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
    stepIndex: 3,
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
    trajectory,
  };
}

describe("flow-runner/executeStepWithHealing — captcha-gated fallback phantom-click runner-up retry (acceptance)", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("retries the runner-up when the ranked top pick's click shows zero observable effect, and completes via the real navigation", async () => {
    const { page, runnerUpClicked } = makeFakePage();
    const stagehand = {} as Stagehand;
    const trajectory: {
      stepIndex: number;
      verifiedBy: AttemptRecord["verifiedBy"];
      targetId?: string;
    }[] = [];

    const result = await executeStepWithHealing(baseParams(page, stagehand, trajectory));

    expect(result).toBe("completed");
    expect(runnerUpClicked.n).toBe(1);
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "url" }]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("navigation to a new origin/path confirmed the advance")
    );
  });

  it("credits a mid-flow Register submit whose top pick swapped the page text with unchanged html size, without clicking the runner-up", async () => {
    const { page, runnerUpClicked, clicks } = makeFakePage({ topPickSwapsText: true });
    const trajectory: {
      stepIndex: number;
      verifiedBy: AttemptRecord["verifiedBy"];
      targetId?: string;
    }[] = [];

    const result = await executeStepWithHealing({
      ...baseParams(page, makeUnresolvedStagehand(), trajectory),
      step: "Click Register to create the account",
      isFinalStep: false,
      captchaGated: false,
    });

    expect(result).toBe("completed");
    expect(runnerUpClicked.n).toBe(0);
    expect(clicks).toEqual([0]);
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("phantom-clicked; retrying runner-up")
    );
  });

  it("does not credit the same text swap on the final step via DOM alone, and retries the runner-up", async () => {
    const { page, runnerUpClicked } = makeFakePage({ topPickSwapsText: true });
    const trajectory: {
      stepIndex: number;
      verifiedBy: AttemptRecord["verifiedBy"];
      targetId?: string;
    }[] = [];

    const result = await executeStepWithHealing({
      ...baseParams(page, makeUnresolvedStagehand(), trajectory),
      step: "Click Register to create the account",
      isFinalStep: true,
      captchaGated: false,
    });

    expect(runnerUpClicked.n).toBeGreaterThan(0);
    expect(result).toBe("completed");
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "url" }]);
  });
});
