import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHealingFlow, submitCaptchaGatedForm } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Parity for the bypass sites the sibling bypass-sites acceptance does not
 * reach (submitCaptchaGatedForm, probeChildFrameSubmitFallback): a non-final
 * submit-shaped click whose header flips at once but whose body re-renders
 * seconds later, with no counted network, must be credited once the page
 * settles, while a click that changes nothing stays phantom.
 */

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: false, reason: "no evidence" })),
}));

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const NEXT_STEP = "Wait for the next section";
const URL = "https://example.org/signup";
const DELAYS_MS = [3000, 8000, 11000];
const PRE_TEXT_LEN = 996;
const POST_TEXT_LEN = 588;
const PRE_BYTES = 31284;
const POST_BYTES = 29300;
const CANDIDATE: SubmitCandidate = {
  deepIndex: 2,
  tier: 3,
  tag: "button",
  accessibleName: "create account",
};

interface Surface {
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: (ms: number) => Promise<void>;
  clicks: () => number;
  rendered: () => boolean;
  elapsed: () => number;
}

/**
 * Scripted page surface: the click flips the header immediately and the body
 * re-renders `delayMs` of settle-clock later. Extra evaluate routing is
 * delegated to `fallback` so each site can answer its own probes.
 */
function buildSurface(
  advances: boolean,
  delayMs: number,
  fallback: (src: string) => unknown,
  options: { advancingClick?: number; candidates?: number } = {}
): Surface {
  const advancingClick = options.advancingClick ?? 1;
  const ranked = Array.from({ length: options.candidates ?? 1 }, (_, n) => ({
    ...CANDIDATE,
    deepIndex: CANDIDATE.deepIndex + n,
  }));
  let now = 0;
  let clickedAt: number | null = null;
  let clicks = 0;
  let rendered = false;
  const snapshot = (): unknown => {
    const flipped = clickedAt !== null;
    const text = rendered ? POST_TEXT_LEN : PRE_TEXT_LEN;
    const full = `${flipped ? "Signed in as jane@example.com" : "Sign In"} ${"t".repeat(text)}`;
    return {
      html: rendered ? POST_BYTES : PRE_BYTES,
      text: `${text}:${full.slice(0, 200)}`,
      values: "",
      state: "",
      full,
      digest: `${flipped ? "b" : "a"}${rendered ? "2" : "1"}:${text}`,
    };
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return ranked;
    if (src.includes('__mouse("click"')) {
      clicks += 1;
      if (advances && clickedAt === null && clicks >= advancingClick) clickedAt = now;
      return { clicked: true };
    }
    if (src.includes("outerHTML")) return snapshot();
    return fallback(src);
  });
  return {
    evaluate,
    clicks: () => clicks,
    rendered: () => rendered,
    elapsed: () => now,
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (clickedAt !== null && !rendered && now - clickedAt >= delayMs) rendered = true;
    },
  };
}

function fakePage(surface: Surface, frames: unknown[] = []): Page {
  return {
    evaluate: surface.evaluate,
    url: () => URL,
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: surface.waitForTimeout,
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => frames,
  } as unknown as Page;
}

function captchaTarget(page: Page, surface: Surface): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    evaluate: surface.evaluate,
    locator: page.locator.bind(page),
    url: async () => URL,
    title: async () => "Sign In",
  } as unknown as FrameTarget;
}

async function runPrimaryFlow(advances: boolean, delay: number): Promise<unknown> {
  const surface = buildSurface(advances, delay, () => null);
  const baseEvaluate = surface.evaluate.getMockImplementation() as (e: unknown) => Promise<unknown>;
  const nextStepActs = { n: 0 };
  surface.evaluate.mockImplementation(async (expr: unknown) => {
    const n = nextStepActs.n;
    if (n > 0 && String(expr).includes("outerHTML")) {
      return { html: 4096 + n * 900, text: `${n}:next${n}`, full: `next${n}`, digest: `n${n}` };
    }
    return baseEvaluate(expr);
  });
  const page = fakePage(surface);
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction === STEP)
        await (surface.evaluate as (e: unknown) => Promise<unknown>)('__mouse("click"');
      else nextStepActs.n += 1;
      return {
        success: true,
        message: "ok",
        actionDescription: "click",
        actions: [{ selector: "button#x", description: "click", method: "click" }],
      } as ActResult;
    }),
    observe: vi.fn().mockResolvedValue([{ selector: "button#x", description: "x" }]),
  } as unknown as Stagehand;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });
}

async function runChildFrameFlow(
  advances: boolean,
  delay: number
): Promise<{ result: unknown; childSurface: Surface }> {
  const childSurface = buildSurface(advances, delay, (src) =>
    src === "location.href" ? "https://example.org/embedded" : null
  );
  const childEvaluate = childSurface.evaluate as (e: unknown) => Promise<unknown>;
  const frame = {
    frameId: "child",
    evaluate: (e: unknown) =>
      e === "location.href" ? Promise.resolve("https://example.org/embedded") : childEvaluate(e),
  };
  const mainSurface = buildSurface(false, delay, () => null);
  mainSurface.evaluate.mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return [];
    if (src.includes('__mouse("click"')) return { clicked: false };
    if (src.includes("outerHTML")) {
      const n = nextStepActs.n;
      return { html: 4096 + n * 900, text: `${n}:next${n}`, full: `next${n}`, digest: `n${n}` };
    }
    return null;
  });
  const page = fakePage(mainSurface, [frame]);
  (page as unknown as { waitForTimeout: unknown }).waitForTimeout = childSurface.waitForTimeout;
  const nextStepActs = { n: 0 };
  const act: ActResult = {
    success: false,
    message: "no candidates resolved",
    actionDescription: "click",
    actions: [{ selector: "button#x", description: "click", method: "click" }],
  };
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction !== NEXT_STEP) return act;
      nextStepActs.n += 1;
      return { ...act, success: true };
    }),
    observe: vi.fn().mockResolvedValue([{ selector: "button#x", description: "x" }]),
  } as unknown as Stagehand;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  const result = await runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });

  return { result, childSurface };
}

describe("flow-runner — mid-flow late re-render parity at the captcha-gated and child-frame sites", () => {
  beforeEach(() => vi.clearAllMocks());

  describe.each(DELAYS_MS)("with a body re-render %ims after the header flip", (delay) => {
    it("credits the submitCaptchaGatedForm click without falling to the form-level submit", async () => {
      const submitExprRan = vi.fn();
      const surface = buildSurface(true, delay, (src) => {
        if (src.includes("requestSubmit")) submitExprRan();
        return true;
      });
      const page = fakePage(surface);

      const result = await submitCaptchaGatedForm(
        captchaTarget(page, surface),
        "h-captcha-response",
        {
          signalCounter: { n: 0 },
          page,
          step: STEP,
          isMidFlowSubmitStep: true,
        }
      );

      expect(result).toBe(true);
      expect(surface.rendered()).toBe(true);
      expect(surface.clicks()).toBe(1);
      expect(submitExprRan).not.toHaveBeenCalled();
    });

    it("credits the probeChildFrameSubmitFallback click without a runner-up or exhaustion", async () => {
      const { result, childSurface } = await runChildFrameFlow(true, delay);

      expect(result).toMatchObject({ lastStepIndex: 1 });
      expect(childSurface.rendered()).toBe(true);
      expect(childSurface.clicks()).toBe(1);
    });
  });

  describe.each(DELAYS_MS)(
    "deep-submit runner-up with a body re-render %ims after the flip",
    (delay) => {
      it("credits the runner-up click when only it advances, without the form-level submit", async () => {
        const submitExprRan = vi.fn();
        const surface = buildSurface(
          true,
          delay,
          (src) => {
            if (src.includes("requestSubmit")) submitExprRan();
            return true;
          },
          { advancingClick: 2, candidates: 2 }
        );
        const page = fakePage(surface);

        const result = await submitCaptchaGatedForm(
          captchaTarget(page, surface),
          "h-captcha-response",
          { signalCounter: { n: 0 }, page, step: STEP, isMidFlowSubmitStep: true }
        );

        expect(result).toBe(true);
        expect(surface.rendered()).toBe(true);
        expect(surface.clicks()).toBe(2);
        expect(submitExprRan).not.toHaveBeenCalled();
      });
    }
  );

  it("keeps a runner-up click that changes nothing phantom (falls to the form-level submit)", async () => {
    const submitExprRan = vi.fn();
    const surface = buildSurface(
      false,
      8000,
      (src) => {
        if (src.includes("requestSubmit")) submitExprRan();
        return true;
      },
      { candidates: 2 }
    );
    const page = fakePage(surface);

    await submitCaptchaGatedForm(captchaTarget(page, surface), "h-captcha-response", {
      signalCounter: { n: 0 },
      page,
      step: STEP,
      isMidFlowSubmitStep: true,
    });

    expect(surface.clicks()).toBe(2);
    expect(submitExprRan).toHaveBeenCalled();
  });

  it("keeps a no-op submitCaptchaGatedForm click phantom (falls to the form-level submit)", async () => {
    const submitExprRan = vi.fn();
    const surface = buildSurface(false, 8000, (src) => {
      if (src.includes("requestSubmit")) submitExprRan();
      return true;
    });
    const page = fakePage(surface);

    await submitCaptchaGatedForm(captchaTarget(page, surface), "h-captcha-response", {
      signalCounter: { n: 0 },
      page,
      step: STEP,
      isMidFlowSubmitStep: true,
    });

    expect(surface.rendered()).toBe(false);
    expect(submitExprRan).toHaveBeenCalled();
  });

  describe.each(DELAYS_MS)("primary path with a body re-render %ims after the flip", (delay) => {
    it("credits the primary click, matching the bypass sites", async () => {
      await expect(runPrimaryFlow(true, delay)).resolves.toMatchObject({ lastStepIndex: 1 });
    });
  });

  it("keeps a no-op primary click phantom, matching the bypass sites", async () => {
    await expect(runPrimaryFlow(false, 8000)).rejects.toThrow(/failed verification/);
  });

  it("keeps a no-op probeChildFrameSubmitFallback click phantom (never credited)", async () => {
    await expect(runChildFrameFlow(false, 8000)).rejects.toThrow(/failed verification/);
  });

  it("gives up a no-op submitCaptchaGatedForm click at the same settle bound regardless of the late-render delay", async () => {
    const elapsed = await Promise.all(
      [3000, 11000].map(async (delay) => {
        const surface = buildSurface(false, delay, () => true);
        const page = fakePage(surface);
        await submitCaptchaGatedForm(captchaTarget(page, surface), "h-captcha-response", {
          signalCounter: { n: 0 },
          page,
          step: STEP,
          isMidFlowSubmitStep: true,
        });
        return surface.elapsed();
      })
    );

    expect(elapsed[0]).toBe(elapsed[1]);
    expect(elapsed[0]).toBeLessThan(30000);
  });
});
