import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A non-final submit-shaped click on a signup wizard flips the header at once,
 * while ambient DOM mutation (a ticking widget) keeps the page's mutation
 * counter moving and the main body re-renders well past the settle's quiet
 * window with no counted network and no URL change. The step must be credited
 * once the page advanced from step start; a click that changes nothing keeps
 * its give-up bound and the final submit stays strict.
 */

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: false, reason: "no evidence" })),
}));

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const NEXT_STEP = "Wait for the next section";
const URL = "https://example.org/signup";
const DELAYS_MS = [20000, 40000, 75000];

interface Surface {
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: (ms: number) => Promise<void>;
  clicks: () => number;
  rendered: () => boolean;
  elapsed: () => number;
}

function buildSurface(advances: boolean, delayMs: number, ambient: boolean): Surface {
  let now = 0;
  let clickedAt: number | null = null;
  let clicks = 0;
  let rendered = false;
  let mutations = 0;
  const snapshot = (): unknown => {
    const flipped = clickedAt !== null;
    const text = rendered ? 588 : 996;
    return {
      html: rendered ? 29300 : 31284,
      text: rendered
        ? "588:Skip to main content|Settings|<email>|Careers Home|Candidate Home|"
        : "996:Skip to main content|Sign In|Careers Home|",
      values: "",
      state: "",
      full: `${flipped ? "Signed in as jane@example.com" : "Sign In"} ${"t".repeat(text)}`,
      digest: `${flipped ? "b" : "a"}${rendered ? "2" : "1"}:${text}`,
    };
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort"))
      return [{ deepIndex: 2, tier: 3, tag: "button", accessibleName: "create account" }];
    if (src.includes('__mouse("click"')) {
      clicks += 1;
      if (advances && clickedAt === null) clickedAt = now;
      return { clicked: true };
    }
    if (src.includes("outerHTML")) return snapshot();
    if (src.includes("__settleQ")) {
      if (ambient) mutations += 1;
      return { pending: 0, mutations };
    }
    return null;
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

async function runPrimaryFlow(
  advances: boolean,
  delay: number,
  options: { ambient?: boolean; isFinal?: boolean } = {}
): Promise<{ result: unknown; surface: Surface }> {
  const surface = buildSurface(advances, delay, options.ambient ?? true);
  const baseEvaluate = surface.evaluate.getMockImplementation() as (e: unknown) => Promise<unknown>;
  const nextStepActs = { n: 0 };
  surface.evaluate.mockImplementation(async (expr: unknown) => {
    const n = nextStepActs.n;
    if (n > 0 && String(expr).includes("outerHTML")) {
      return { html: 4096 + n * 900, text: `${n}:next${n}`, full: `next${n}`, digest: `n${n}` };
    }
    return baseEvaluate(expr);
  });
  const page = {
    evaluate: surface.evaluate,
    url: () => URL,
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({ isChecked: async () => false, inputValue: async () => "" }),
    }),
    waitForTimeout: surface.waitForTimeout,
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => [],
  } as unknown as Page;
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction === STEP) await surface.evaluate('__mouse("click"');
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
  const result = await runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
      ...(options.isFinal
        ? []
        : [{ instruction: NEXT_STEP, optional: true, upload: false, submitStep: false }]),
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch((err: unknown) => err);
  return { result, surface };
}

describe("flow-runner — mid-flow submit with ambient mutation and a late body re-render", () => {
  beforeEach(() => vi.clearAllMocks());

  describe.each(DELAYS_MS)("with a body re-render %ims after the header flip", (delay) => {
    it("credits the primary click once the page advanced from step start", async () => {
      const { result, surface } = await runPrimaryFlow(true, delay);
      expect(result).toMatchObject({ lastStepIndex: 1 });
      expect(surface.rendered()).toBe(true);
      expect(surface.clicks()).toBe(1);
    });
  });

  it("keeps a no-op click phantom at the same give-up bound regardless of the delay", async () => {
    const runs = await Promise.all(DELAYS_MS.map((d) => runPrimaryFlow(false, d)));
    for (const run of runs) expect(run.result).toBeInstanceOf(Error);
    const elapsed = runs.map((r) => r.surface.elapsed());
    expect(new Set(elapsed).size).toBe(1);
  });

  it("keeps the genuine final submit strict", async () => {
    const { result } = await runPrimaryFlow(true, 40000, { isFinal: true });
    expect(result).toBeInstanceOf(Error);
  });
});
