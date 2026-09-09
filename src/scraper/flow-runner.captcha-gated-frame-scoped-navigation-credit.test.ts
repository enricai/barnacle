import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-frame-scoped-navigation-credit-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-gated-frame-scoped-navigation-credit-")
);

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { runHealingFlow } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance test for the reported symptom: a `captchaGated` step's
 * widget submit navigates only the resolved child frame — the wrapper
 * `page.url()` never moves, only the iframe's `location.href` does. Drives
 * the REAL `runHealingFlow` / `executeStepWithHealing` / `resolveFrameTarget`
 * stack (only Stagehand's `Page`/`Frame` are faked), matching
 * `flow-runner.deep-locator-scope-widening.test.ts`'s harness convention.
 */

const ORIGIN = "https://forms.example.com";
const IFRAME_SELECTOR = "iframe#wizard_frame";
const ENTRY_PATH = "/wizard/entry";
const REVIEW_PATH = "/wizard/review";
const CHILD_SRC = `${ORIGIN}${ENTRY_PATH}`;
const SUBMIT_STEP = "Solve the captcha and submit the wizard entry";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function allLoggedLines(): string {
  return (testLogger.info as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => String(call[0]))
    .join("\n");
}

/** Fake child `Frame`: a mutable `location.href` (moves on submit) plus the captcha-gated evaluate surface. */
function makeFakeChildFrame(childUrl: { current: string }) {
  return {
    frameId: "child-wizard",
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src === "location.href") return childUrl.current;
      if (src === "document.readyState") return "complete";
      // `injectCaptchaTokenAndSubmit`'s precheck: unique field-existence shape
      // (`fieldExists`), checked before the sitekey-probe's `getAttribute`
      // branch below, since the precheck's embedded `findCaptchaCallbackExprSrc`
      // helper also contains a `getAttribute` call.
      if (src.includes("fieldExists")) {
        return { fieldExists: false, hasForm: true, callbackDiscovered: false };
      }
      if (src.includes("data-sitekey") && src.includes("isInvisible")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src.includes('return "absent"')) return "populated";
      if (src.includes("requestSubmit")) {
        // Modeling the reported symptom: the widget's own submit machinery
        // navigates only the child frame in place — never the top window.
        childUrl.current = `${ORIGIN}${REVIEW_PATH}`;
        return undefined;
      }
      return null;
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
  } as unknown as ReturnType<Page["frames"]>[number];
}

/** Fake wrapper `Page`: `url()` is fixed at the entry URL for the whole test — it never moves. */
function makeFakeTopPage(childFrame: ReturnType<Page["frames"]>[number]) {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("IFRAME")) return { matched: true, src: CHILD_SRC };
      if (src === "navigator.userAgent") return "test-agent/1.0";
      return null;
    }),
    frames: vi.fn().mockReturnValue([childFrame]),
    mainFrameId: vi.fn().mockReturnValue("main"),
    title: vi.fn().mockResolvedValue(""),
    url: () => `${ORIGIN}${ENTRY_PATH}`,
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi
      .fn()
      .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    getSessionForFrame: () => session,
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

describe("flow-runner/runHealingFlow — captchaGated step credits a frame-scoped, wrapper-page-invisible advance", () => {
  let capturesDir: string;

  beforeEach(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
    solveCaptchaMock.mockReset();
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("completes on captchaAttempt=1 when only the child frame's location.href moves and page.url() stays fixed", async () => {
    const childUrl = { current: CHILD_SRC };
    const childFrame = makeFakeChildFrame(childUrl);
    const page = makeFakeTopPage(childFrame);
    const stagehand = {} as Stagehand;

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: SUBMIT_STEP,
          optional: false,
          upload: false,
          submitStep: true,
          captchaGated: true,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.submitVerified).toBe(true);
    expect(result.submitStepSkipped).toBe(false);
    expect(childUrl.current).toBe(`${ORIGIN}${REVIEW_PATH}`);
    expect(page.url()).toBe(`${ORIGIN}${ENTRY_PATH}`);
    expect(solveCaptchaMock).toHaveBeenCalledTimes(1);

    const logged = allLoggedLines();
    expect(logged).toMatch(/post-submit navigation to a new origin\/path confirmed the advance/);
    expect(logged).not.toContain("attempt=2/3");
    expect(logged).not.toMatch(/retrying/);
  });
});
