import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-003's substring-specificity fix, pinned at the level
 * users actually observe it: a flow step naming a specific confirmation-style
 * field ("Verify New Password") must resolve to that field's own control via
 * `runHealingFlow`'s deep-locator seam, not a shorter sibling ("Password")
 * whose label happens to be a substring of the query — even though the live
 * control's accessible name carries drift from the step's own wording (a
 * trailing " *" required-field marker). Distinct from
 * flow-runner.deep-locator-field-label-priority.test.ts, which covers
 * Stagehand resolving to a real-but-wrong control rather than this
 * candidate-ranking defect.
 */

const TOP_ORIGIN = "https://portal.example.org";
const CHILD_ORIGIN = "https://accounts.example-vendor.com";
const IFRAME_SELECTOR = "iframe#account_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/account/settings`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_STEP = "Fill in the Verify New Password field with 'Secret123!'";
/** DOM order matters: the short generic "Password" sits before the specific confirmation control, whose live label carries a required-field marker the step's wording lacks. */
const CANDIDATE_SET = ["Password", "Verify New Password *", "Email"];

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function makeFakeStagehandNoResolution() {
  return {
    act: async () => ({ success: false, message: "not found", actionDescription: "", actions: [] }),
    observe: async () => [],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

function makeFakeChildFrame(childUrls: { current: string }) {
  return {
    evaluate: async (expr: unknown) => (expr === "location.href" ? childUrls.current : null),
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
  };
}

function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  return {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR
          ? { matched: true, src: CHILD_SRC }
          : { matched: false, src: null };
      }
      return null;
    },
    url: () => topUrl.current,
    title: async () => "Example Account Portal",
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
    frames: () => [childFrame],
    deepLocator: fakeDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

async function runSingleStep(instruction: string) {
  const topUrl = { current: `${TOP_ORIGIN}/settings/security` };
  const childUrls = { current: CHILD_SRC };
  const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
  const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, CANDIDATE_SET);
  registerDeepLocatorHopElements(deepLocatorFrame, PROBE_HOP_SELECTOR, ["reachability probe"]);
  const stagehand = makeFakeStagehandNoResolution();
  const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

  const run = () =>
    runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

  return { run, hop };
}

describe("flow-runner deep-locator field-label substring-specificity regression (bugfix-003)", () => {
  it("fills the specific confirmation control, not the shorter sibling it substring-matches, despite label drift", async () => {
    const { run, hop } = await runSingleStep(FILL_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [passwordEl, verifyPasswordEl, emailEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(verifyPasswordEl!.filledWith).toBe("Secret123!");
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(passwordEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(emailEl!.filledWith).toBeNull();
    for (const el of hop.elements) {
      expect(el.clicks).toBe(0);
    }
  });
});
