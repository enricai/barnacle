import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A mid-flow submit-shaped click whose settled post read shows the header
 * flipped and the visible text shrunk (no counted network, same URL) must be
 * credited even when the new page carries invalid-marked required controls:
 * those markers describe the page the click landed on, not a failed click.
 */

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: vi.fn(async () => ({ advanced: false, reason: "no change" })),
}));

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({
    verified: false,
    rationale: "no evidence",
    reason: "no evidence",
    dom_signal: null,
    url_signal: null,
  })),
}));

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the Create Account button to submit the account creation form";
const NEXT_STEP = "Wait for the next section";
const URL = "https://example.org/signup";
const PRE_TEXT_LEN = 996;
const POST_TEXT_LEN = 588;
const PRE_SIGNATURE = "996:Skip to main content|Sign In|Careers Home|";
const POST_SIGNATURE = "588:Skip to main content|Settings|<email>|Careers Home|Candidate Home|";
const PRE_BYTES = 31284;
const POST_BYTES = 29300;
const INVALID_AFTER_ADVANCE = 3;
const DELAYS_MS = [0, 8000];

interface Surface {
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: (ms: number) => Promise<void>;
  clicks: () => number;
  rendered: () => boolean;
}

/**
 * Scripted page: the click flips the header at once and the body re-renders
 * `delayMs` of settle-clock later; once clicked, the page reports invalid
 * markers when `invalidMarkers` is set.
 */
function buildSurface(advances: boolean, delayMs: number, invalidMarkers: boolean): Surface {
  let now = 0;
  let clickedAt: number | null = null;
  let clicks = 0;
  let rendered = false;
  const snapshot = (): unknown => {
    const flipped = clickedAt !== null;
    const text = rendered ? POST_TEXT_LEN : PRE_TEXT_LEN;
    return {
      html: rendered ? POST_BYTES : PRE_BYTES,
      text: rendered ? POST_SIGNATURE : PRE_SIGNATURE,
      values: "",
      state: "",
      full: `${flipped ? "Signed in as jane@example.com" : "Sign In"} ${"t".repeat(text)}`,
      digest: `${flipped ? "b" : "a"}${rendered ? "2" : "1"}:${text}`,
    };
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return [];
    if (src.includes('__mouse("click"')) {
      clicks += 1;
      if (advances && clickedAt === null) {
        clickedAt = now;
        if (delayMs === 0) rendered = true;
      }
      return { clicked: true };
    }
    if (src.includes("outerHTML")) return snapshot();
    if (src.includes("[class],[aria-invalid]")) {
      return invalidMarkers && clickedAt !== null ? INVALID_AFTER_ADVANCE : 0;
    }
    return null;
  });
  return {
    evaluate,
    clicks: () => clicks,
    rendered: () => rendered,
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (clickedAt !== null && !rendered && now - clickedAt >= delayMs) rendered = true;
    },
  };
}

function fakePage(surface: Surface): Page {
  return {
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
}

function newLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function logLines(logger: Logger): string[] {
  return vi
    .mocked(logger.info)
    .mock.calls.concat(vi.mocked(logger.warn).mock.calls)
    .map((c) => String(c[0]));
}

type Route = "primary" | "retry";

async function run(options: {
  route: Route;
  advances: boolean;
  delay: number;
  judge: boolean;
}): Promise<{ result: unknown; surface: Surface; logger: Logger }> {
  const surface = buildSurface(options.advances, options.delay, true);
  const baseEvaluate = surface.evaluate.getMockImplementation() as (e: unknown) => Promise<unknown>;
  const nextStepActs = { n: 0 };
  surface.evaluate.mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (nextStepActs.n > 0 && src.includes("outerHTML")) {
      const n = nextStepActs.n;
      return { html: 4096 + n * 900, text: `${n}:next${n}`, full: `next${n}`, digest: `n${n}` };
    }
    if (
      options.route === "retry" &&
      src.includes("FIRST_ORDERED_NODE_TYPE") &&
      src.includes("el.click")
    ) {
      await baseEvaluate('__mouse("click"');
      return { fired: true, kind: "click" };
    }
    return baseEvaluate(expr);
  });
  const stagehand = {
    act: vi.fn().mockImplementation(async (instruction: unknown) => {
      if (instruction === NEXT_STEP) nextStepActs.n += 1;
      else if (options.route === "primary") await baseEvaluate('__mouse("click"');
      return {
        success: true,
        message: "ok",
        actionDescription: "click",
        actions: [{ selector: "xpath=/html/body/button", description: "click", method: "click" }],
      } as ActResult;
    }),
    observe: vi.fn().mockResolvedValue([{ selector: "xpath=/html/body/button", description: "x" }]),
  } as unknown as Stagehand;
  const logger = newLogger();
  const result = await runHealingFlow({
    stagehand,
    page: fakePage(surface),
    steps: [
      {
        instruction: STEP,
        optional: false,
        upload: false,
        submitStep: options.route === "primary",
      },
      { instruction: NEXT_STEP, optional: true, upload: false, submitStep: false },
    ],
    logger,
    anthropic: options.judge ? ({} as never) : null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch((err: unknown) => err);
  return { result, surface, logger };
}

describe("flow-runner — advanced page's invalid markers do not veto a mid-flow advance", () => {
  beforeEach(() => vi.clearAllMocks());

  describe.each(DELAYS_MS)("with a body re-render %ims after the header flip", (delay) => {
    it.each([
      ["primary path, judge rejecting", "primary", true],
      ["primary path, judge null", "primary", false],
      ["n+16 fallback, judge rejecting", "retry", true],
      ["n+16 fallback, judge null", "retry", false],
    ] as const)("credits the click: %s", async (_name, route, judge) => {
      const { result, surface, logger } = await run({ route, advances: true, delay, judge });

      expect(result).toMatchObject({ lastStepIndex: 1 });
      expect(surface.rendered()).toBe(true);
      expect(surface.clicks()).toBe(1);
      expect(logLines(logger).some((l) => /phantom-click-exhausted|replan/i.test(l))).toBe(false);
    });
  });

  it.each([
    ["primary", "primary"],
    ["n+16 fallback", "retry"],
  ] as const)("keeps a no-op click phantom on the %s path", async (_name, route) => {
    const { result } = await run({ route, advances: false, delay: 8000, judge: false });

    expect(result).toBeInstanceOf(Error);
  });
});
