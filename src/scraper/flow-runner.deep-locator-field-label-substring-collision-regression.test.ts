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
 * Regression pinning bugfix-003's fix (most-specific-wins, not first-match-
 * wins) at `findDeepLocatorCandidateByFieldLabel` itself — the decision site
 * every LIVE fill/select step routes through, independent of and textually
 * separate from the replan staleness checks already covered by
 * flow-runner.deep-locator-field-label-priority.test.ts and
 * flow-runner.deep-locator-field-label-specificity.test.ts. A shorter
 * sibling control ("Password") sits earlier in deepLocator scan order than
 * the true target ("Confirm Password"); without specificity ranking, the
 * step would land on the sibling purely because it was the first
 * bidirectional-substring match encountered.
 */

const TOP_ORIGIN = "https://signup.example.org";
const CHILD_ORIGIN = "https://accounts.example-vendor.com";
const IFRAME_SELECTOR = "iframe#signup_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/signup/abc-123`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_STEP = "Fill in the Acme Confirm Password field with 's3cret!'";
/** DOM order matters: the shorter, generic "Password" sits before the specific "Confirm Password" control. */
const CANDIDATE_SET = ["Password", "Confirm Password", "Full Name"];

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
    title: async () => "Example Signup",
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
  const topUrl = { current: `${TOP_ORIGIN}/account/new` };
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

describe("flow-runner deep-locator field-label substring-collision regression", () => {
  it("resolves to the specific sibling control, never the shorter earlier substring match", async () => {
    const { run, hop } = await runSingleStep(FILL_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [passwordEl, confirmPasswordEl, fullNameEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(confirmPasswordEl!.filledWith).toBe("s3cret!");
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(passwordEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(fullNameEl!.filledWith).toBeNull();
    for (const el of hop.elements) {
      expect(el.clicks).toBe(0);
    }
  });
});
