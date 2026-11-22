import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import {
  FILLABLE_CANDIDATE_SELECTOR,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Coverage for bugfix-002: a focusable `<label tabindex="-1" for="pw">` sits before its input in the
 * INTERACTIVE/wildcard universes but is absent from the fillable universe a fill step
 * resolves over. (follow-up to bugfix-001's City-field
 * diagnostic): a frame-scoped fill/select step must route to the
 * deterministic accessible-name field-label match EVEN WHEN Stagehand's own
 * act()/observe() resolves to a real, visible, WRONG control — not just when
 * observe() comes back empty. Before this fix, a nonempty (but wrong)
 * Stagehand candidate short-circuited the `candidates.length === 0` gates
 * that guarded the deterministic branch, so the cascade acted on Stagehand's
 * mis-resolution (the City-vs-header-search-box case) instead of ever
 * reaching `findDeepLocatorCandidateByFieldLabel`.
 */

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example-vendor.com";
const IFRAME_SELECTOR = "iframe#apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${FILLABLE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_STEP = "Fill in the Password field with 'hunter2'";
/** DOM order matching the bug report's shape: an unrelated header search box (Stagehand's wrong pick) sits alongside the real City field. */
const CANDIDATE_SET = ["First Name", "Password", "Last Name"];

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `act()`/`observe()` resolve a REAL, in-DOM, WRONG
 * control (the header search box), never empty — the shape bugfix-001
 * pinned as the City field's actual failure mode, distinct from the
 * observe-blind fixtures used by bugfix-003's suite.
 */
function makeFakeStagehandWrongResolution() {
  const wrongAction = {
    selector: "css=header .job-search-input",
    description: 'fill the "Search job title or location" textbox',
    method: "fill",
    arguments: ["Austin"],
  };
  return {
    act: async () => ({
      success: true,
      message: "filled",
      actionDescription: wrongAction.description,
      actions: [wrongAction],
    }),
    observe: async () => [wrongAction],
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

describe("fill step with a tabindex'd label next to its input (bugfix-002)", () => {
  it("writes to the input, never the label, resolving over the fillable universe", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const frame: FakeDeepLocatorFrame = new Map();
    // Fillable universe: inputs only.
    const hop = registerDeepLocatorHopElements(frame, HOP_SELECTOR, CANDIDATE_SET);
    // Interactive / wildcard universes would also contain the tabindex'd label.
    const labelled = ["Password label", ...CANDIDATE_SET];
    const interactive = registerDeepLocatorHopElements(
      frame,
      `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`,
      labelled
    );
    const wildcard = registerDeepLocatorHopElements(frame, PROBE_HOP_SELECTOR, labelled);
    const page = makeFakeTopPage(topUrl, childUrls, frame);

    const result = await runHealingFlow({
      stagehand: makeFakeStagehandWrongResolution(),
      page,
      steps: [{ instruction: FILL_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(hop.elements.map((e) => e.filledWith)).toEqual([null, "hunter2", null]);
    for (const el of [...interactive.elements, ...wildcard.elements]) {
      expect(el.filledWith).toBeNull();
    }
  });
});
