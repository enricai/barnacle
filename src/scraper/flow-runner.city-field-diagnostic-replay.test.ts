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
 * Replays the exact reported DOM shape from
 * `/work/oopif-iframe-repro/oopif-11-city-diagnostic.json` (the
 * recon-11 step-9 City-field diagnostic) rather than a generic duplicate-node
 * fixture, so bugfix-002/bugfix-003's routing fix is pinned against the
 * literal failure this report captured, not just an invented shape.
 *
 * Two things the diagnostic JSON establishes verbatim:
 * - `finalObserve`/`attempts[0]` show Stagehand's own `act()` resolving to
 *   `"Search job title or location textbox, which is the closest available
 *   input field that can be used to fill in a city/location"` (`resolvedMethod:
 *   "fill"`, `resolvedArguments: ["Austin"]`, `phantomClickVerdict:
 *   "phantom"`) — a REAL, in-DOM, visible, WRONG header control, never an
 *   empty observe() result.
 * - `bodyOuterHtml` (offset ~13486-14700) shows the wizard's real City input
 *   as a MUI-rendered `<input>` with
 *   `id="fieldV29ya2xldEl0ZW06OkZpZWxkLTE0OTU2NDAyNjZfZmllbGRfY2l0eQ=="`,
 *   `autocomplete="address-level2"`, labelled "City" via a `for=`-linked
 *   `<label>` — a plain, visible, enabled text input, not a combobox.
 *
 * The report additionally flags (unconfirmed) a "10 ids / 40 occurrences"
 * duplicate-node lead in that same dump; this fixture includes one
 * non-committing duplicate copy of the City input alongside the genuine one,
 * so the replay also exercises bugfix-003's write-verify defense
 * (`deep-locator-actuate.duplicate-node-fill.test.ts`) converging on the
 * committing node instead of a phantom copy — without asserting the
 * duplicate-node mechanism as the CONFIRMED cause, which the report itself
 * declines to assert.
 */

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example.com";
const IFRAME_SELECTOR = "iframe#apply_frame";
const CHILD_SRC = `${CHILD_ORIGIN}/application/9092a0da-ff56-4c5a-b0d6-41ff0f818cb1`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

/** Verbatim step instruction from the diagnostic's `originalStep`. */
const FILL_CITY_STEP = "Fill in the City field with 'Austin'";

/**
 * Verbatim accessible-name text the diagnostic's `attempts[0].actResultDescription`
 * gives for Stagehand's own (wrong) resolution of the header search box.
 */
const HEADER_SEARCH_BOX_TEXT =
  "Search job title or location textbox, which is the closest available input field that can be used to fill in a city/location";

/** Accessible name the wizard's real City `<label for=...>` (diagnostic `bodyOuterHtml`) resolves to. */
const CITY_LABEL_TEXT = "City";

/** DOM order matching the diagnostic's own layout: the header search box (outside the wizard, earlier in document order) precedes the wizard's fields; a non-committing duplicate copy of City sits adjacent to the genuine one, matching the report's flagged (unconfirmed) duplicate-node lead. */
const CANDIDATE_SET = [
  HEADER_SEARCH_BOX_TEXT,
  "First Name",
  { text: CITY_LABEL_TEXT, visible: true }, // duplicate copy (non-committing)
  { text: CITY_LABEL_TEXT, visible: true }, // genuine wizard City input
  "Last Name",
];
const DUPLICATE_CITY_INDEX = 2;
const GENUINE_CITY_INDEX = 3;

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `act()`/`observe()` resolve the diagnostic's OWN
 * captured wrong action verbatim (selector, description, method, arguments)
 * — never empty, matching `attempts[0]`'s real shape rather than the
 * observe-blind fixtures `bugfix-003`'s suite already covers.
 */
function makeFakeStagehandDiagnosticResolution() {
  const wrongAction = {
    selector:
      "xpath=/html[1]/body[1]/div[3]/div[2]/header[1]/div[2]/div[1]/div[3]/div[1]/div[4]/div[1]/form[1]/div[2]/div[1]/div[1]/input[1]",
    description: HEADER_SEARCH_BOX_TEXT,
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

function makeFakeChildFrame() {
  return {
    evaluate: async (expr: unknown) => (expr === "location.href" ? CHILD_SRC : null),
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
  };
}

function makeFakeTopPage(deepLocatorFrame: FakeDeepLocatorFrame) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame();
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
    url: () => `${TOP_ORIGIN}/jobs/rn-cath-lab/apply`,
    title: async () => "the top-window site Careers",
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

describe("flow-runner City-field diagnostic replay (oopif-11 step-9, offline fixture, no network)", () => {
  it("fills the wizard's real, verified City input, not the phantom header search box or its non-committing duplicate copy", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, CANDIDATE_SET);
    registerDeepLocatorHopElements(deepLocatorFrame, PROBE_HOP_SELECTOR, ["reachability probe"]);

    // The duplicate copy never commits its write — the diagnostic's
    // flagged (unconfirmed) duplicate-node lead: a batched-scan match on a
    // same-named copy whose fill doesn't stick.
    const duplicateCity = hop.elements[DUPLICATE_CITY_INDEX];
    if (!duplicateCity) throw new Error("test setup: expected duplicate City element");
    duplicateCity.readBackValue = "";

    const stagehand = makeFakeStagehandDiagnosticResolution();
    const page = makeFakeTopPage(deepLocatorFrame);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: FILL_CITY_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);

    const genuineCity = hop.elements[GENUINE_CITY_INDEX];
    expect(genuineCity?.filledWith).toBe("Austin");
    expect(genuineCity?.readBackValue).toBeUndefined();

    // The non-committing duplicate's own write/read-back verify honestly
    // reports the write didn't stick (bugfix-003's write-verify defense),
    // which is what makes the cascade exclude it and converge on the
    // genuine node instead of trusting a phantom "written" — not that the
    // duplicate was never attempted at all.
    expect(duplicateCity.readBackValue).toBe("");

    // The header search box (the diagnostic's actual phantom-click target)
    // and every other candidate never receive the fill, and nothing was
    // clicked — a fill/select step never clicks a candidate.
    for (const [index, element] of hop.elements.entries()) {
      expect(element.clicks).toBe(0);
      if (index === GENUINE_CITY_INDEX || index === DUPLICATE_CITY_INDEX) continue;
      expect(element.filledWith).toBeNull();
    }
  });
});
