import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * A submit-shaped mid-flow step whose first attempt resolves no candidate at all (act throws, or
 * reports failure with no actions) must still reach the deep submit-control locator, and the top
 * pick's click — header flipped at once, body re-rendered seconds later, no counted network —
 * must be credited against the step-start page rather than judged phantom.
 */

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: false, reason: "no evidence" })),
}));

const STEP =
  "On the sign-up form (Email and Password already filled), click the 'Create Account' button to submit the sign-up form";
const NEXT_STEP = "Wait for the next section";
const URL = "https://example.org/signup";
const PRE_TEXT_LEN = 996;
const POST_TEXT_LEN = 588;
const TOP: SubmitCandidate = {
  deepIndex: 2,
  tier: 3,
  tag: "button",
  accessibleName: "create account",
};
const RUNNER_UP: SubmitCandidate = { deepIndex: 3, tier: 2, tag: "div", accessibleName: "create" };

interface Surface {
  page: Page;
  clicks: { top: number; runnerUp: number };
}

/** Header flips on the top pick's click; the body re-renders `delayMs` of virtual wait later. */
function buildSurface(delayMs: number, onNextStep: () => number, flips: boolean): Surface {
  const clicks = { top: 0, runnerUp: 0 };
  let now = 0;
  let clickedAt: number | null = null;
  let rendered = false;
  const snapshot = (): unknown => {
    const flipped = clickedAt !== null;
    const text = rendered ? POST_TEXT_LEN : PRE_TEXT_LEN;
    const full = `${flipped ? "Signed in as jane@example.com" : "Sign In"} ${"t".repeat(text)}`;
    return {
      html: rendered ? 29300 : 31284,
      text: `${text}:${full.slice(0, 200)}`,
      values: "",
      state: "",
      full,
      digest: `${flipped ? "b" : "a"}${rendered ? "2" : "1"}:${text}`,
    };
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const centred = answerCentreHitTest(expr);
    if (centred) return centred;
    const src = String(expr);
    if (src.includes("ranked.sort")) return [TOP, RUNNER_UP];
    if (src.includes(`all[${TOP.deepIndex}]`)) {
      clicks.top += 1;
      if (clickedAt === null && flips) clickedAt = now;
      return { clicked: true };
    }
    if (src.includes(`all[${RUNNER_UP.deepIndex}]`)) {
      clicks.runnerUp += 1;
      return { clicked: true };
    }
    if (src.includes("outerHTML")) {
      const next = onNextStep();
      return next > 0
        ? {
            html: 4096 + next * 900,
            text: `${next}:next${next}`,
            full: `next${next}`,
            digest: `n${next}`,
          }
        : snapshot();
    }
    return null;
  });
  const page = {
    evaluate,
    url: () => URL,
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({ isChecked: async () => false, inputValue: async () => "" }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (clickedAt !== null && !rendered && now - clickedAt >= delayMs) rendered = true;
    },
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return { page, clicks };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

async function run(
  delayMs: number,
  firstAct: () => Promise<unknown>,
  flips = true
): Promise<{ result: unknown; surface: Surface; acts: () => number }> {
  const nextStepActs = { n: 0 };
  const surface = buildSurface(delayMs, () => nextStepActs.n, flips);
  let stepActs = 0;
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction === NEXT_STEP) {
        nextStepActs.n += 1;
        return {
          success: true,
          message: "ok",
          actionDescription: "click",
          actions: [{ selector: "button#n", description: "click", method: "click" }],
        };
      }
      stepActs += 1;
      return firstAct();
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        instruction === NEXT_STEP
          ? [{ selector: "button#n", description: "next" }]
          : [{ selector: "button#x", description: "Create Account", method: "click" }]
      ),
  } as unknown as Stagehand;
  const result = await runHealingFlow({
    stagehand,
    page: surface.page,
    steps: [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch((err: unknown) => err);
  return { result, surface, acts: () => stepActs };
}

const THROWS = async (): Promise<never> => {
  throw new Error("act could not resolve an element");
};
const FAILS_WITH_NO_ACTIONS = async (): Promise<unknown> => ({
  success: false,
  message: "no actionable element found",
  actionDescription: "could not resolve Create Account",
  actions: [],
});

describe("flow-runner — a mid-flow submit whose first attempt resolved nothing still reaches the deep top pick", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [label, firstAct] of [
    ["act throws", THROWS],
    ["act reports failure with no actions", FAILS_WITH_NO_ACTIONS],
  ] as const) {
    for (const delayMs of [1000, 11000, 14000]) {
      it(`credits the top pick landing ${delayMs}ms late when ${label}, without the runner-up`, async () => {
        const { result, surface } = await run(delayMs, firstAct);

        expect(result).not.toBeInstanceOf(Error);
        expect(surface.clicks.top).toBe(1);
        expect(surface.clicks.runnerUp).toBe(0);
      });
    }
  }

  it("keeps a top pick that changes nothing phantom and falls to the runner-up", async () => {
    const { result, surface } = await run(1000, FAILS_WITH_NO_ACTIONS, false);

    expect(result).toBeInstanceOf(Error);
    expect(surface.clicks.top).toBeGreaterThan(0);
    expect(surface.clicks.runnerUp).toBeGreaterThan(0);
  });
});
