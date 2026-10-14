import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Account creation is started from the sign-in page, so the unchanged URL is
 * sign-in-shaped. The destination veto exists to catch a click that BOUNCED to
 * an auth gate; a click that never left its URL must still be credited on the
 * page's own demonstrable advance (visible text swapped, no network, stale title).
 */

interface PageState {
  html: number;
  textLength: number;
  head: string;
  waits: number;
  clicked: boolean;
  later?: { atWait: number; apply: (s: PageState) => void };
}

function buildWorld(params: {
  url: string;
  step: string;
  submitStep: boolean;
  onClick: (s: PageState) => void;
}): { page: Page; stagehand: Stagehand; logger: Logger; info: string[]; steps: HealingFlowStep[] } {
  const state: PageState = {
    html: 10000,
    textLength: 1000,
    head: "Sign In Create an account Name Email Password Register",
    waits: 0,
    clicked: false,
  };
  const info: string[] = [];
  const logger = {
    info: vi.fn((m: string) => info.push(m)),
    warn: vi.fn((m: string) => info.push(m)),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: state.html, text: `${state.textLength}:${state.head}`, values: "" };
      }
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    },
    url: () => params.url,
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({
        click: async () => {},
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {
      state.waits += 1;
      if (state.later && state.waits >= state.later.atWait) {
        state.later.apply(state);
        state.later = undefined;
      }
    },
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  const stagehand = {
    act: vi.fn().mockImplementation(async () => {
      if (!state.clicked) {
        state.clicked = true;
        params.onClick(state);
      }
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked",
        actions: [{ selector: "css=#go", description: "go", method: "click" }],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;
  const steps: HealingFlowStep[] = [
    { instruction: params.step, optional: false, upload: false, submitStep: params.submitStep },
    { instruction: "Click the 'Details' link", optional: true, upload: false, submitStep: false },
  ];
  return { page, stagehand, logger, info, steps };
}

async function runStepOne(world: ReturnType<typeof buildWorld>): Promise<void> {
  await runHealingFlow({
    stagehand: world.stagehand,
    page: world.page,
    steps: world.steps,
    logger: world.logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch(() => undefined);
}

const creditedOnAttempt1 = (info: string[]): boolean =>
  info.some((l) => l.includes("step 1/2") && l.includes("succeeded on attempt 1"));

const SIGN_IN_URLS = ["https://example.org/signin", "https://example.org/login?next=%2Fhome"];

describe("flow-runner mid-flow submit on an unchanged sign-in-shaped URL", () => {
  for (const url of SIGN_IN_URLS) {
    it(`credits account creation whose header flips and text shrinks 41% (${url})`, async () => {
      const world = buildWorld({
        url,
        step: "Click the 'Create account' button",
        submitStep: true,
        onClick: (s) => {
          s.html = 5900;
          s.textLength = 590;
          s.head = "Create your account Name Email Password";
        },
      });
      await runStepOne(world);
      expect(creditedOnAttempt1(world.info)).toBe(true);
    });
  }

  it("credits a 'Continue' step whose visible text is replaced by the next page", async () => {
    const world = buildWorld({
      url: SIGN_IN_URLS[0] as string,
      step: "Click the 'Continue' button",
      submitStep: true,
      onClick: (s) => {
        s.head = "Shipping address Street City ZIP";
      },
    });
    await runStepOne(world);
    expect(creditedOnAttempt1(world.info)).toBe(true);
  });

  it("credits a header flip followed by a late body re-render", async () => {
    const world = buildWorld({
      url: SIGN_IN_URLS[0] as string,
      step: "Click the 'Create account' button",
      submitStep: true,
      onClick: (s) => {
        s.head = "Create your account Name Email Password Register";
        s.textLength = 1005;
        s.later = {
          atWait: s.waits + 4,
          apply: (late) => {
            late.textLength = 590;
            late.html = 5900;
            late.head = "Verify your email address we sent a link";
          },
        };
      },
    });
    await runStepOne(world);
    expect(creditedOnAttempt1(world.info)).toBe(true);
  });

  it("still does not credit a no-op click on the sign-in URL", async () => {
    const world = buildWorld({
      url: SIGN_IN_URLS[0] as string,
      step: "Click the 'Create account' button",
      submitStep: true,
      onClick: () => {},
    });
    await runStepOne(world);
    expect(creditedOnAttempt1(world.info)).toBe(false);
  });
});
