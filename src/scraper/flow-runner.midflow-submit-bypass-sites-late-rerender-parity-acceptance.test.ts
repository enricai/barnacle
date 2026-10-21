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
const NEUTRAL_STEP = "On the registration form, press the highlighted control";
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
  options: { advancingClick?: number; candidates?: number; renderAtSnapshot?: number } = {}
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
  let snapshots = 0;
  const snapshot = (): unknown => {
    snapshots += 1;
    if (snapshots === options.renderAtSnapshot) rendered = true;
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

function elementShapeProbe(src: string): unknown {
  const isShapeProbe = src.includes("isSubmitShaped(el)") && !src.includes("isDisabled");
  return isShapeProbe ? true : null;
}

async function runPrimaryFlow(
  advances: boolean,
  delay: number,
  options: { step?: string; submitStep?: boolean; errorAfterClick?: boolean } = {}
): Promise<unknown> {
  const step = options.step ?? STEP;
  const surface = buildSurface(advances, delay, options.step ? elementShapeProbe : () => null);
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
      if (instruction === step) {
        await (surface.evaluate as (e: unknown) => Promise<unknown>)('__mouse("click"');
        if (options.errorAfterClick) throw new Error("act errored after the click landed");
      } else nextStepActs.n += 1;
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
      { instruction: step, optional: false, upload: false, submitStep: options.submitStep ?? true },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });
}

/**
 * Drives the n+16 `el.click()` retry for an UNFLAGGED step: Stagehand's own
 * click lands as a phantom (no page effect), so only the retry's click
 * expression can advance the scripted page.
 */
async function runRetryFlow(
  advances: boolean,
  delay: number,
  options: {
    submitStep?: boolean;
    isFinal?: boolean;
    step?: string;
    renderAtSnapshot?: number;
  } = {}
): Promise<{ result: unknown; surface: Surface }> {
  const step = options.step ?? STEP;
  const surface = buildSurface(advances, delay, options.step ? elementShapeProbe : () => null, {
    renderAtSnapshot: options.renderAtSnapshot,
  });
  const baseEvaluate = surface.evaluate.getMockImplementation() as (e: unknown) => Promise<unknown>;
  const nextStepActs = { n: 0 };
  surface.evaluate.mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (nextStepActs.n > 0 && src.includes("outerHTML")) {
      const n = nextStepActs.n;
      return { html: 4096 + n * 900, text: `${n}:next${n}`, full: `next${n}`, digest: `n${n}` };
    }
    if (src.includes("FIRST_ORDERED_NODE_TYPE") && src.includes("el.click")) {
      return baseEvaluate('__mouse("click"').then(() => ({ fired: true, kind: "click" }));
    }
    return baseEvaluate(expr);
  });
  const page = fakePage(surface);
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction === NEXT_STEP) nextStepActs.n += 1;
      return {
        success: true,
        message: "ok",
        actionDescription: "click",
        actions: [{ selector: "xpath=/html/body/button", description: "click", method: "click" }],
      } as ActResult;
    }),
    observe: vi.fn().mockResolvedValue([{ selector: "xpath=/html/body/button", description: "x" }]),
  } as unknown as Stagehand;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const steps = [
    {
      instruction: step,
      optional: false,
      upload: false,
      submitStep: options.submitStep ?? false,
    },
    ...(options.isFinal
      ? []
      : [{ instruction: NEXT_STEP, optional: true, upload: false, submitStep: false }]),
  ];
  const result = await runHealingFlow({
    stagehand,
    page,
    steps,
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch((err: unknown) => err);
  return { result, surface };
}

async function runChildFrameFlow(
  advances: boolean,
  delay: number,
  step: string = STEP
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
      { instruction: step, optional: false, upload: false, submitStep: true },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });

  return { result, childSurface };
}

/**
 * Drives the runner's own exits: observe never resolves a candidate and the
 * page's DOM advances (or not) at the first observe, i.e. after the step-start
 * snapshot, with the same URL and no counted network. `cascade` makes observe
 * resolve a candidate whose act reports no change, reaching cascade-exhausted.
 */
async function runExitFlow(options: {
  advances: boolean;
  cascade: boolean;
  isFinal: boolean;
}): Promise<unknown> {
  let advanced = false;
  const snapshot = (): unknown => {
    const text = advanced ? POST_TEXT_LEN : PRE_TEXT_LEN;
    const full = `Sign In ${"t".repeat(text)}`;
    return {
      html: advanced ? POST_BYTES : PRE_BYTES,
      text: `${text}:${full.slice(0, 200)}`,
      values: "",
      state: "",
      full,
      digest: `a${advanced ? "2" : "1"}:${text}`,
    };
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return [];
    if (src.includes("outerHTML")) return snapshot();
    return null;
  });
  const page = {
    ...(fakePage({ evaluate, waitForTimeout: async () => {} } as unknown as Surface) as object),
  } as unknown as Page;
  const candidate = [{ selector: "button#x", description: "x" }];
  const stagehand = {
    act: vi.fn().mockResolvedValue({
      success: false,
      message: "no change",
      actionDescription: "click",
      actions: [{ selector: "button#x", description: "click", method: "click" }],
    } as ActResult),
    observe: vi.fn().mockImplementation(async (instruction?: unknown) => {
      if (instruction === STEP && !advanced && options.advances) advanced = true;
      return instruction === STEP && options.cascade ? candidate : [];
    }),
  } as unknown as Stagehand;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const steps = [
    { instruction: STEP, optional: false, upload: false, submitStep: true },
    ...(options.isFinal
      ? []
      : [{ instruction: NEXT_STEP, optional: true, upload: false, submitStep: false }]),
  ];
  return runHealingFlow({
    stagehand,
    page,
    steps,
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });
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

    it("credits the probeChildFrameSubmitFallback click for the neutral step", async () => {
      const { result, childSurface } = await runChildFrameFlow(true, delay, NEUTRAL_STEP);

      expect(result).toMatchObject({ lastStepIndex: 1 });
      expect(childSurface.rendered()).toBe(true);
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

  describe.each(DELAYS_MS)(
    "resolved-element-only submit shape with a body re-render %ims after the flip",
    (delay) => {
      it("credits the unflagged non-submit-worded primary click on a submit-shaped control", async () => {
        await expect(
          runPrimaryFlow(true, delay, { step: NEUTRAL_STEP, submitStep: false })
        ).resolves.toMatchObject({ lastStepIndex: 1 });
      });

      it("credits a neutral-step click whose act errors after it landed, from the step-start baseline", async () => {
        await expect(
          runPrimaryFlow(true, delay, {
            step: NEUTRAL_STEP,
            submitStep: false,
            errorAfterClick: true,
          })
        ).resolves.toMatchObject({ lastStepIndex: 1 });
      });

      it("credits the unflagged n+16 retry click on a submit-shaped control", async () => {
        const { result, surface } = await runRetryFlow(true, delay, { step: NEUTRAL_STEP });

        expect(result).toMatchObject({ lastStepIndex: 1 });
        expect(surface.rendered()).toBe(true);
      });

      it("credits the deep-submit runner-up and captcha-gated clicks for the neutral step", async () => {
        const submitExprRan = vi.fn();
        const probe = (src: string): unknown => {
          if (src.includes("requestSubmit")) submitExprRan();
          return true;
        };
        const gated = buildSurface(true, delay, probe);
        const gatedPage = fakePage(gated);
        const deep = buildSurface(true, delay, probe, { advancingClick: 2, candidates: 2 });
        const deepPage = fakePage(deep);

        const results = [
          await submitCaptchaGatedForm(captchaTarget(gatedPage, gated), "h-captcha-response", {
            signalCounter: { n: 0 },
            page: gatedPage,
            step: NEUTRAL_STEP,
            isMidFlowSubmitStep: true,
          }),
          await submitCaptchaGatedForm(captchaTarget(deepPage, deep), "h-captcha-response", {
            signalCounter: { n: 0 },
            page: deepPage,
            step: NEUTRAL_STEP,
            isMidFlowSubmitStep: true,
          }),
        ];

        expect(results).toEqual([true, true]);
        expect(gated.rendered() && deep.rendered()).toBe(true);
        expect(deep.clicks()).toBe(2);
        expect(submitExprRan).not.toHaveBeenCalled();
      });
    }
  );

  it("keeps a no-op resolved-element-shaped primary click phantom", async () => {
    await expect(runPrimaryFlow(false, 8000, { step: NEUTRAL_STEP })).rejects.toThrow(
      /failed verification/
    );
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

  describe.each(DELAYS_MS)("n+16 retry with a body re-render %ims after the flip", (delay) => {
    it("credits the unflagged retry click without a replan", async () => {
      const { result, surface } = await runRetryFlow(true, delay);

      expect(result).toMatchObject({ lastStepIndex: 1 });
      expect(surface.rendered()).toBe(true);
      expect(surface.clicks()).toBe(1);
    });
  });

  it("gives up a no-op n+16 retry click at the same settle bound regardless of the late-render delay", async () => {
    const runs = await Promise.all([3000, 11000].map(async (delay) => runRetryFlow(false, delay)));

    expect(runs[0]?.result).toBeInstanceOf(Error);
    expect(runs[0]?.surface.elapsed()).toBe(runs[1]?.surface.elapsed());
  });

  // The 19th snapshot is the first one after the attempt's `pre` was captured,
  // so the late re-render is absorbed into `pre` and the fallback click sees
  // no further change: only the step-start baseline still shows the advance.
  it("credits the n+16 fallback click when a late re-render was absorbed into the attempt's pre", async () => {
    const { result, surface } = await runRetryFlow(false, 8000, {
      step: NEUTRAL_STEP,
      renderAtSnapshot: 19,
    });

    expect(result).toMatchObject({ lastStepIndex: 1 });
    expect(surface.rendered()).toBe(true);
    expect(surface.clicks()).toBe(1);
  });

  it("keeps the genuine final submit strict on the retry (no-op is not credited)", async () => {
    const { result } = await runRetryFlow(false, 8000, { submitStep: true, isFinal: true });

    expect(result).toBeInstanceOf(Error);
  });

  describe.each([
    ["probe-absent", false],
    ["cascade-exhausted", true],
  ])("%s exit against the step-start baseline", (_name, cascade) => {
    it("credits a DOM-only advance (same URL, no network) without throwing", async () => {
      await expect(runExitFlow({ advances: true, cascade, isFinal: false })).resolves.toMatchObject(
        { lastStepIndex: 1 }
      );
    });

    it("still throws when the page is identical to step start", async () => {
      await expect(runExitFlow({ advances: false, cascade, isFinal: false })).rejects.toThrow(
        /step 1\/\d+ \(On the account registration/
      );
    });

    it("does not credit the same advance on a final step", async () => {
      await expect(runExitFlow({ advances: true, cascade, isFinal: true })).rejects.toThrow(
        /step 1\/\d+ \(On the account registration/
      );
    });
  });
});
