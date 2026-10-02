import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Mirror-image regression pin for the `hasOriginOrPathChanged` destination-
 * corroboration fix (recon-view-swap-click-credited-on-bare-url-reload-
 * without-destination-check.md): that report's reload landed back on the
 * SAME path (cosmetic query-param churn only), which the fix must veto.
 * This fixture is the opposite shape — a non-submit, non-captcha click
 * whose handler navigates to a genuinely DIFFERENT path on the same origin
 * — and must still be credited `verifiedBy=url`, proving the fix only
 * vetoes same-path cosmetic reloads, not real navigations.
 */

const BASE_URL = "https://apply.example.com/profile";
const CONFIRM_URL = "https://apply.example.com/profile/confirm";
const REVEAL_STEP = "Click the 'Continue' button to view your application status";

const DOM_SNAPSHOT: { html: number; text: string } = {
  html: 1000,
  text: "1000:Profile",
};

/** Plain top-window `Page` fake: a click handler advances `state.url` to a genuinely different path, with no DOM growth and no network capture — isolating the URL signal as the only credit path. */
function makePage(state: { url: string }): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async () => DOM_SNAPSHOT,
    url: () => state.url,
    title: async () => "Application Status | Careers",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function makeStagehand(state: { url: string; clickCount: number }): Stagehand {
  return {
    act: vi.fn().mockImplementation(async () => {
      state.clickCount += 1;
      state.url = CONFIRM_URL;
      return {
        success: true,
        message: "clicked",
        actionDescription: REVEAL_STEP,
        actions: [
          {
            selector: "css=[data-automation-id=continueButton]",
            description: "Continue",
            method: "click",
          },
        ],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const STEPS: HealingFlowStep[] = [
  { instruction: REVEAL_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner genuine same-path-changing navigation — url credit regression (no over-correction)", () => {
  it("credits a non-submit, non-captcha click as succeeded via verifiedBy=url when it navigates to a genuinely different path on the same origin", async () => {
    const pageState = { url: BASE_URL };
    const stagehandState = { url: BASE_URL, clickCount: 0 };
    const page = makePage(pageState);
    // `snapshotPage` reads `page.url()` directly; route the same mutable
    // URL through both the Stagehand fake's click handler and the Page
    // fake so pre/post snapshots see the real transition.
    const syncedPage = {
      ...page,
      url: () => stagehandState.url,
    } as unknown as Page;
    const stagehand = makeStagehand(stagehandState);

    const info: string[] = [];
    const logger = {
      info: vi.fn((msg: string) => info.push(msg)),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const result = await runHealingFlow({
      stagehand,
      page: syncedPage,
      steps: STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(stagehandState.clickCount).toBe(1);
    expect(stagehandState.url).toBe(CONFIRM_URL);
    expect(
      info.some(
        (line) =>
          line.includes("succeeded on attempt 1") &&
          line.includes("url=true") &&
          line.includes("verifiedBy=url")
      )
    ).toBe(true);
  });
});
