import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-submit-navigation-credit-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-gated-submit-navigation-credit-acceptance-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import type { AttemptRecord } from "@/scraper/flow-runner";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Acceptance-level reproduction of the reported failure mode: a generic
 * multi-step application-form flow with a captcha-gated final submit that
 * full-page-submits (no XHR body the requestPostData pattern can match) but
 * DOES change the frame's URL/origin. Drives the real, exported
 * `executeStepWithHealing` (no internals reached into directly) with a fake
 * Stagehand `Page`, mirroring `flow-runner.captcha-gated-submit-hook.test.ts`'s
 * harness and `flow-runner.captcha-gated-submit-inject.test.ts`'s technique of
 * running the real eval expressions against a bare fake DOM. Before the fix
 * (0c26bca / 61a6a0a), this step fell through to phantom-click-exhausted;
 * it must now resolve "completed" with the trajectory tagged `verifiedBy:
 * "url"`.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Minimal fake application-form DOM + Stagehand `Page`, driven entirely through `page.evaluate`. */
function makeFakePage(): { page: Page; submitCount: { n: number } } {
  const submitCount = { n: 0 };

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes('return "absent"')) return "absent";
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("requestSubmit")) {
      submitCount.n += 1;
      return undefined;
    }
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  const page = {
    evaluate,
    // Full-page multipart submit: the frame navigates to a new path on the
    // same origin once the explicit fallback submit fires, with no matching
    // XHR body ever landing for the requestPostData-based poll to see.
    url: () =>
      submitCount.n > 0
        ? "https://forms.example.com/apply/confirmation"
        : "https://forms.example.com/apply/review",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  return { page, submitCount };
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
    advanceTransitionBodyPattern: "type=next",
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
    trajectory,
  };
}

describe("flow-runner/executeStepWithHealing — captcha-gated full-page-submit navigation credit (acceptance)", () => {
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

  it("credits the step as completed on the observed origin/path navigation, tagging the trajectory verifiedBy 'url', when no capture ever matches the requestPostData pattern", async () => {
    const { page, submitCount } = makeFakePage();
    const stagehand = {} as Stagehand;
    const trajectory: {
      stepIndex: number;
      verifiedBy: AttemptRecord["verifiedBy"];
      targetId?: string;
    }[] = [];
    // Neither waitForTransitionBody poll (post-inject, post-fallback-submit)
    // ever has anything to match — no capture is ever written to disk — so
    // force their real widened (45s) deadlines past immediately. This runs
    // ahead of the navigation-credit poll's own un-timed first check, which
    // observes the fallback submit's synchronous page.url() flip.
    const nowSpy = vi.spyOn(performance, "now");
    let calls = 0;
    nowSpy.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? 0 : Number.POSITIVE_INFINITY;
    });

    const result = await executeStepWithHealing(baseParams(page, stagehand, trajectory));
    nowSpy.mockRestore();

    expect(result).toBe("completed");
    expect(submitCount.n).toBe(1);
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "url" }]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("navigation to a new origin/path confirmed the advance")
    );
  });
});
