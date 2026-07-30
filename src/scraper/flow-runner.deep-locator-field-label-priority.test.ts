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
 * Regression for bugfix-002 (follow-up to bugfix-001's City-field
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
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_CITY_STEP = "Fill in the City field with 'Austin'";
/** DOM order matching the bug report's shape: an unrelated header search box (Stagehand's wrong pick) sits alongside the real City field. */
const CANDIDATE_SET = ["Search job title or location", "First Name", "City", "Last Name"];

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

async function runSingleStep(instruction: string) {
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
  const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, CANDIDATE_SET);
  registerDeepLocatorHopElements(deepLocatorFrame, PROBE_HOP_SELECTOR, ["reachability probe"]);
  const stagehand = makeFakeStagehandWrongResolution();
  const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

  const run = () =>
    runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

  return { run, hop };
}

describe("flow-runner field-label-first routing over a nonempty Stagehand resolution (bugfix-002)", () => {
  it("fills the correctly-labelled field via the deep-locator seam, ignoring Stagehand's wrong-but-nonempty resolution", async () => {
    const { run, hop } = await runSingleStep(FILL_CITY_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [searchBoxEl, firstNameEl, cityEl, lastNameEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(cityEl!.filledWith).toBe("Austin");
    // Stagehand's own (wrong) resolution never lands a fill through the
    // deepLocator seam, and no candidate was clicked at all.
    for (const el of hop.elements) {
      expect(el.clicks).toBe(0);
    }
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(searchBoxEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(firstNameEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(lastNameEl!.filledWith).toBeNull();
  });

  it("falls back to Stagehand's own resolution (not a refusal) when no deep-locator candidate names the field", async () => {
    // No candidate in CANDIDATE_SET is "Middle Name" — the field-label
    // pre-check must report no-match and let the existing act()/observe()
    // path run instead of refusing outright the way the observe-empty
    // branch does when IT finds no field-label match. This fixture's fake
    // Stagehand never wires a verifiable side effect for its own
    // resolution, so the cascade exhausts and throws — proving control
    // passed through the fallback path (never touching the deep-locator
    // seam) rather than asserting a success this fixture can't model.
    const { run, hop } = await runSingleStep("Fill in the Middle Name field with 'Q'");

    await expect(run()).rejects.toThrow(/failed verification after \d+ attempts/);

    for (const el of hop.elements) {
      expect(el.filledWith).toBeNull();
      expect(el.clicks).toBe(0);
    }
  });
});
