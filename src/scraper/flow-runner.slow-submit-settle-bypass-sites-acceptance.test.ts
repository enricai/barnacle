import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import {
  type HealingFlowStep,
  runHealingFlow,
  submitCaptchaGatedForm,
} from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Acceptance pin for the bypass sites that snapshot a click's effect without
 * waiting for the page to settle: the deep-submit-locator runner-up retry's
 * mid-post snapshot and the captcha-gated submit helper. A top pick whose
 * effect lands ~6s after the click must not be classified phantom, so the
 * runner-up control is never clicked. Time is virtual: `waitForTimeout`
 * advances a clock that starts at the top-pick click, and the URL flips once
 * 6s have been waited, so a snapshot taken without a settle sees no effect.
 */

const BEFORE_URL = "https://shop.example/checkout/review";
const AFTER_URL = "https://shop.example/checkout/confirmation";
const LATE_MS = 6000;
const TOP: SubmitCandidate = {
  deepIndex: 4,
  tier: 3,
  tag: "button",
  accessibleName: "place order",
};
const RUNNER_UP: SubmitCandidate = {
  deepIndex: 7,
  tier: 2,
  tag: "div",
  accessibleName: "place order now",
};

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Fake page whose URL flips to {@link AFTER_URL} once 6s were waited after the top pick was clicked. */
function makeSlowPage(): {
  page: Page;
  evaluate: ReturnType<typeof vi.fn>;
  clicksOf: (candidate: SubmitCandidate) => number;
} {
  const state = { topClicked: false, waitedMs: 0 };
  const clicks = new Map<number, number>();
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return [TOP, RUNNER_UP];
    for (const candidate of [TOP, RUNNER_UP]) {
      if (src.includes(`all[${candidate.deepIndex}]`)) {
        clicks.set(candidate.deepIndex, (clicks.get(candidate.deepIndex) ?? 0) + 1);
        if (candidate === TOP) state.topClicked = true;
        return { clicked: true };
      }
    }
    if (src.includes("outerHTML")) return { html: 4096, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  const page = {
    evaluate,
    url: () => (state.waitedMs >= LATE_MS ? AFTER_URL : BEFORE_URL),
    title: vi.fn().mockResolvedValue("Checkout"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      if (state.topClicked) state.waitedMs += ms;
    }),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return { page, evaluate, clicksOf: (candidate) => clicks.get(candidate.deepIndex) ?? 0 };
}

describe("slow submit settle — bypass sites do not click the runner-up", () => {
  it("deep-submit-locator runner-up retry: a top pick landing ~6s late is not phantom", async () => {
    const { page, clicksOf } = makeSlowPage();
    const unresolved: ActResult = {
      success: false,
      message: "no candidates resolved",
      actionDescription: "Click the 'Place Order' button",
      actions: [
        { selector: "button#place-order", description: "Click Place Order", method: "click" },
      ],
    };
    const stagehand = {
      act: vi.fn().mockResolvedValue(unresolved),
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#place-order", description: "Click Place Order", method: "click" },
        ]),
    } as unknown as Stagehand;
    const steps: HealingFlowStep[] = [
      {
        instruction: "Click the 'Place Order' button to submit the order",
        optional: false,
        upload: false,
        submitStep: true,
      },
    ];

    await runHealingFlow({
      stagehand,
      page,
      steps,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);

    expect(clicksOf(TOP)).toBeGreaterThan(0);
    expect(clicksOf(RUNNER_UP)).toBe(0);
  });

  it("captcha-gated submit helper: a top pick landing ~6s late is not phantom", async () => {
    const { page, evaluate, clicksOf } = makeSlowPage();
    const target = {
      url: async () => page.url(),
      evaluate: (expr: string) =>
        src_isFindForm(expr)
          ? Promise.resolve(true)
          : (evaluate as unknown as (e: string) => Promise<unknown>)(expr),
    };

    const submitted = await submitCaptchaGatedForm(
      target as unknown as Parameters<typeof submitCaptchaGatedForm>[0],
      "h-captcha-response",
      { signalCounter: { n: 0 }, page, step: "Solve the captcha and submit the application" }
    );

    expect(submitted).toBe(true);
    expect(clicksOf(TOP)).toBe(1);
    expect(clicksOf(RUNNER_UP)).toBe(0);
  });
});

function src_isFindForm(expr: string): boolean {
  return (
    expr.includes("sitekeyForm") && expr.includes("closest") && !expr.includes("requestSubmit")
  );
}
