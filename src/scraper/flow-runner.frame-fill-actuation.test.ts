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
 * Regression for bugfix-003: a frame-scoped FILL step whose observe() comes
 * back empty must actuate the candidate matching the NAMED FIELD through
 * `fillDeepLocatorCandidate` (`deep-locator-actuate.ts`), never
 * `clickFirstActionableCandidate`'s click-only walk. Before the fix, the
 * cascade's `resolveDeepLocatorCandidates` ranking scores every candidate by
 * the instruction's quoted VALUE ('Reginald') — which matches no control's
 * accessible name — so every candidate ties at score 0 and the click walk
 * fires on whichever sits first in DOM order. This suite pins the fixed
 * scenario from the bug report: "Close" (the wizard's own dismiss control)
 * sits first, so a passing fill-with-no-click here is a genuine falsifier of
 * the old click-cascade behavior, not a tautology.
 *
 * Same "REAL runHealingFlow / resolveFrameTarget / guardedObserve stack,
 * only Stagehand and Playwright's Page/Frame faked" composition as
 * `flow-runner.oopif-candidate-ranking.test.ts`.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** Interactive-scoped hop the attempt-2/4 cascade actually resolves candidates against (see bugfix-005). */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** `probeStepBeforeAttempts` deliberately keeps requesting `"*"` (a reachability gate) — registered separately so the probe reports "present" before the cascade ever runs. */
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

const FILL_FIRST_NAME_STEP = "Fill in the First Name field with 'Reginald'";
const FILL_MIDDLE_NAME_STEP = "Fill in the Middle Name field with 'Q'";
const CLICK_UPLOAD_STEP =
  "In the application widget, click the 'Upload a Resume/CV' button to start the upload flow.";

/** DOM order matching the bug report's shape: the wizard's own 'Close' control sits first — the exact ordering under which the pre-fix click walk mis-clicked it. */
const CANDIDATE_SET = ["Close", "Upload a Resume/CV", "First Name", "Last Name"];

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** Fake Stagehand whose `observe()`/`act()` are blind to the OOPIF, forcing every step through attempt 2's deepLocator fallback — same shape as `flow-runner.oopif-candidate-ranking.test.ts`'s `makeFakeStagehandObserveBlind`. */
function makeFakeStagehandObserveBlind() {
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: "unresolved",
      actions: [],
    }),
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
  // A click on ANY candidate navigates the child frame, mirroring
  // `flow-runner.oopif-candidate-ranking.test.ts`'s wrappedDeepLocator — the
  // click-intent regression test needs a verification signal, and this
  // fixture only ever names one clickable target per test, so "any click
  // navigates" is unambiguous about which click fired. A fill/select write
  // must NOT trigger this (proving the actuation seam is a distinct path
  // from click), which `fill`/`selectOption` deliberately leave untouched.
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const nthDelegate = fakeDeepLocator(selector).nth(index);
        return {
          ...nthDelegate,
          click: async () => {
            await nthDelegate.click();
            childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
          },
        };
      },
    };
  };
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
    title: async () => "UCHealth Careers",
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
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

async function runSingleStep(instruction: string) {
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
  const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, CANDIDATE_SET);
  registerDeepLocatorHopElements(deepLocatorFrame, PROBE_HOP_SELECTOR, ["reachability probe"]);
  const stagehand = makeFakeStagehandObserveBlind();
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

describe("flow-runner frame-scoped fill/select actuation routing (bugfix-003)", () => {
  it("fills the named field's candidate through the actuation seam and clicks nothing", async () => {
    const { run, hop } = await runSingleStep(FILL_FIRST_NAME_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [closeEl, uploadEl, firstNameEl, lastNameEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(firstNameEl!.filledWith).toBe("Reginald");
    // The 'Close' control — first in DOM order, the pre-fix click walk's
    // target — was never clicked, and no candidate was clicked at all.
    for (const el of hop.elements) {
      expect(el.clicks).toBe(0);
    }
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(closeEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(uploadEl!.filledWith).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(lastNameEl!.filledWith).toBeNull();
  });

  it("refuses to click when no candidate matches the named field, instead of falling back to the click cascade", async () => {
    const { run, hop } = await runSingleStep(FILL_MIDDLE_NAME_STEP);

    // No candidate is named "Middle Name" — the step must exhaust the
    // cascade rather than click an unrelated control (the bug report's
    // core requirement).
    await expect(run()).rejects.toThrow(/cascade|attempts|verification|candidates/i);

    for (const el of hop.elements) {
      expect(el.clicks).toBe(0);
      expect(el.filledWith).toBeNull();
    }
  });

  it("still routes a click-intent step through clickFirstActionableCandidate", async () => {
    const { run, hop } = await runSingleStep(CLICK_UPLOAD_STEP);

    const result = await run();

    expect(result.lastStepIndex).toBe(0);
    const [closeEl, uploadEl, firstNameEl, lastNameEl] = hop.elements;
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(uploadEl!.clicks).toBeGreaterThan(0);
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(closeEl!.clicks).toBe(0);
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(firstNameEl!.clicks).toBe(0);
    // biome-ignore lint/style/noNonNullAssertion: CANDIDATE_SET has exactly 4 entries, registered above
    expect(lastNameEl!.clicks).toBe(0);
    for (const el of hop.elements) {
      expect(el.filledWith).toBeNull();
    }
  });
});
