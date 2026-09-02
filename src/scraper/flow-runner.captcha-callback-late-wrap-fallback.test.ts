import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-callback-late-wrap-fallback-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-callback-late-wrap-fallback-")
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

interface FakeField {
  value: string;
  dispatched: string[];
}

/**
 * Fake page whose precheck finds no callback (mirroring a widget whose
 * `hcaptcha.render` call hasn't fired yet at precheck time), but whose
 * late-install re-check DOES find one, once `injectCaptchaTokenAndSubmit`'s
 * `buildHcaptchaCallbackCaptureScript()` install evaluate runs (keyed on the
 * script's own `__barnacleWrapped` marker) — mirroring a widget that renders
 * on demand and is only caught by the late re-check. Set `lateCallbackFound:
 * false` to instead prove the raw field-set fallback runs when even the
 * late re-check finds nothing.
 */
function makeFakePage(opts: { lateCallbackFound: boolean }): {
  page: Page;
  field: FakeField;
  callbackInvokedWith: { token: string | null };
} {
  const field: FakeField = { value: "", dispatched: [] };
  const callbackInvokedWith: { token: string | null } = { token: null };
  let lateInstallRan = false;

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    // Precheck runs first and always reports no callback discoverable yet —
    // this is the scenario the late-wrap re-check exists to catch.
    if (src.includes("fieldExists")) {
      return { fieldExists: true, hasForm: true, callbackDiscovered: false };
    }
    // injectCaptchaTokenAndSubmit's late-install evaluate: the capture
    // script's own self-installation, keyed on its unique marker property.
    if (src.includes("__barnacleWrapped")) {
      lateInstallRan = true;
      return undefined;
    }
    // The late precheck's boolean-only re-lookup, run right after install.
    if (src.includes("return Boolean(__findCaptchaCallback")) {
      return lateInstallRan && opts.lateCallbackFound;
    }
    // Shared by both the immediate and late invoke exprs — only reached
    // once a callback (immediate or late) was actually discovered.
    if (src.includes("canExecute")) {
      callbackInvokedWith.token = "solved-token";
      return undefined;
    }
    if (src.includes("descriptor.set.call")) {
      field.value = "solved-token";
      return undefined;
    }
    if (src.includes("dispatchEvent")) {
      field.dispatched.push("change");
      return undefined;
    }
    if (src.includes("requestSubmit")) return undefined;
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

  return { page, field, callbackInvokedWith };
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

describe("flow-runner/executeStepWithHealing — captcha late-wrap re-check upgrade", () => {
  beforeEach(() => {
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
  });

  it("upgrades to the callback-invoke path instead of the raw field-set fallback once the late install finds a callback", async () => {
    const { page, field, callbackInvokedWith } = makeFakePage({ lateCallbackFound: true });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(baseParams(page, stagehand)).catch(() => {
      // Only the inject primitive's chosen branch is under test here, not
      // the step's eventual poll/verify outcome.
    });

    expect(callbackInvokedWith.token).toBe("solved-token");
    // The raw field-set fallback never ran: no value was assigned to the
    // response field via the descriptor-set path.
    expect(field.value).toBe("");
  });

  it("falls through to the raw field-set fallback when the late install also finds no callback", async () => {
    const { page, field, callbackInvokedWith } = makeFakePage({ lateCallbackFound: false });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(baseParams(page, stagehand)).catch(() => {
      // Only the inject primitive's chosen branch is under test here, not
      // the step's eventual poll/verify outcome.
    });

    expect(callbackInvokedWith.token).toBeNull();
    expect(field.value).toBe("solved-token");
    expect(field.dispatched).toEqual(["change"]);
  });
});
