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
 * Regression for bugfix-003: `findDeepLocatorCandidateByFieldLabel` must
 * pick the MOST SPECIFIC bidirectional-substring candidate, not the first
 * one encountered, when no candidate's accessible name exactly equals the
 * field label. A short generic sibling ("ID") that happens to appear first
 * in deepLocator scan order must lose to a longer, more specific candidate
 * ("Non-Employee ID") whose text differs from the instruction's field noun
 * only by phrasing drift.
 */

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example-vendor.com";
const IFRAME_SELECTOR = "iframe#apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_STEP = "Fill in the Acme Non-Employee ID field with '12345'";
/** DOM order matters: the short generic "ID" sits before the specific "Non-Employee ID" control. */
const CANDIDATE_SET = ["ID", "Non-Employee ID", "Last Name"];

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
    title: async () => "Example Careers",
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
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
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

describe("flow-runner deep-locator field-label specificity ranking (bugfix-003)", () => {
  it("resolves to the more specific bidirectional-substring candidate, not the first generic one", async () => {
    const { run, hop } = await runSingleStep(FILL_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [idEl, nonEmployeeIdEl, lastNameEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(nonEmployeeIdEl!.filledWith).toBe("12345");
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(idEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 3 entries, registered above
    expect(lastNameEl!.filledWith).toBeNull();
  });
});
