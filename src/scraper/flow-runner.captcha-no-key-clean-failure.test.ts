import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-no-key-clean-failure-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-no-key-"));

/**
 * `@/scraper/captcha-solver` is the REAL module here (not mocked) so this
 * exercises the exact "no key configured" branch a production deploy would
 * hit; only `@/config` is stubbed to omit the key, deterministically and
 * regardless of the real process.env at CI time.
 */
const { configRef } = vi.hoisted(() => ({
  configRef: { value: { scraper: { twoCaptchaApiKey: undefined as string | undefined } } },
}));
vi.mock("@/config", () => ({
  get config() {
    return configRef.value;
  },
}));

import { CaptchaSolverUnavailableError, isCaptchaSolverUnavailableError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Fake page exposing only a `[data-sitekey]` widget probe; the solve call must never proceed past config-key checking. */
function makeFakePage(): { page: Page; submitCount: { n: number } } {
  const submitCount = { n: 0 };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("responseField")) {
      submitCount.n += 1;
      return { injected: true, submitted: true };
    }
    if (src.includes("data-sitekey")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    return null;
  });

  const page = {
    evaluate,
    url: () => "https://apply.example.com/application/abc-123",
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

describe("flow-runner/executeStepWithHealing — captcha-gated step with no solver key configured", () => {
  it("fails the step cleanly (never verified/skipped-as-success) instead of silently proceeding", async () => {
    configRef.value = { scraper: { twoCaptchaApiKey: undefined } };
    const { page, submitCount } = makeFakePage();
    const stagehand = {} as Stagehand;

    const outcome = await executeStepWithHealing({
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
      advanceTransitionBodyPattern: "type=next",
      successUrlFragments: [] as string[],
      successPageTitleHints: [] as string[],
      ownBackendHostnames: [] as string[],
      knownErrorClassPrefixes: [] as string[],
      wizardExitButtonLabels: [] as string[],
    }).then(
      (result) => ({ resolved: result }) as const,
      (error: unknown) => ({ rejected: error }) as const
    );

    // The hook must reject (or report a non-success outcome) — never a
    // resolved "completed"/"skipped" that would mask the disabled solver.
    if ("resolved" in outcome) {
      expect(outcome.resolved).not.toBe("completed");
      expect(outcome.resolved).not.toBe("skipped");
    } else {
      expect(outcome.rejected).toBeInstanceOf(CaptchaSolverUnavailableError);
      expect(isCaptchaSolverUnavailableError(outcome.rejected)).toBe(true);
    }

    // The captcha-gated submit primitive (token injection + form submit)
    // must never have run — the step failed before touching the page.
    expect(submitCount.n).toBe(0);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: solve failed")
    );
  });
});
