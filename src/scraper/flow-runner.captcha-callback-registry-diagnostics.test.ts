import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-callback-registry-diagnostics-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-callback-registry-diagnostics-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Fake page whose `registryState` evaluate answer is driven by `registry`:
 * `undefined` mirrors a page that never ran the callback-capture init
 * script at all (absent), while `{}` mirrors one that ran it but never saw
 * a matching `hcaptcha.render` call (empty) — the two states the
 * diagnostics log must distinguish.
 */
function makeFakePage(registry: Record<string, unknown> | undefined): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes('return "absent"')) {
      if (!registry) return "absent";
      return Object.keys(registry).length === 0 ? "empty" : "populated";
    }
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("requestSubmit")) return undefined;
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  return {
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
}

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
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — captcha registry-presence diagnostics", () => {
  beforeEach(() => {
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
  });

  it("logs registryState=absent when the callback-capture registry global was never installed on the target", async () => {
    const page = makeFakePage(undefined);
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(baseParams(page, stagehand)).catch(() => {
      // Only the registryState diagnostic (logged before the poll/cascade
      // runs) is under test here, not the step's eventual outcome.
    });

    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("registryState=absent"));
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("registryState=empty")
    );
  });

  it("logs registryState=empty (distinct from absent) when the registry global exists but has no entries", async () => {
    const page = makeFakePage({});
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(baseParams(page, stagehand)).catch(() => {
      // Only the registryState diagnostic (logged before the poll/cascade
      // runs) is under test here, not the step's eventual outcome.
    });

    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("registryState=empty"));
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("registryState=absent")
    );
  });

  it("logs registryState=populated when the registry global has a captured callback entry", async () => {
    const page = makeFakePage({ "sk-1": { sitekey: "sk-1", callback: () => undefined } });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(baseParams(page, stagehand)).catch(() => {
      // Only the registryState diagnostic (logged before the poll/cascade
      // runs) is under test here, not the step's eventual outcome.
    });

    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("registryState=populated")
    );
  });
});
