import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance test locking in the bug report's exact decoy scenario:
 * `careers.uchealth.org`'s Talemetry apply wizard mounts inside a
 * cross-origin OOPIF whose "*" deepLocator hop matches every element,
 * including four decoy controls the flow's own instruction says NOT to
 * click. Unlike `flow-runner.deep-locator-fallback.test.ts` and
 * `flow-runner.deep-locator-frame.test.ts` (which `vi.mock` `@/scraper/frame-target`
 * and/or `@/scraper/stagehand-guard`), this file drives the REAL
 * `runHealingFlow` / `resolveFrameTarget` / `guardedObserve` stack — only
 * Stagehand and Playwright's `Page`/`Frame` are faked — mirroring
 * `flow-runner.iframe-e2e.test.ts`'s "observe blind to the OOPIF" describe
 * block. "Manual Application" is placed LAST in DOM order deliberately: that
 * is exactly the ordering under which `deepLocatorCandidates[0]` (the
 * pre-bugfix-002 behavior) picks a decoy instead, so this is a genuine
 * falsifier rather than a tautology that would pass even with no ranking at
 * all. The four decoy strings come verbatim from the flow's "Do NOT click"
 * list (`deep-locator-candidates.test.ts`'s `ACCEPTANCE_INSTRUCTION`), which
 * is what makes this the acceptance scenario rather than a synthetic one.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** Interactive-scoped hop the attempt-2/4 cascade actually resolves candidates/clicks against (see bugfix-005). */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** `probeStepBeforeAttempts` deliberately keeps requesting `"*"` (a reachability gate, not the candidate set the cascade acts on — see `deep-locator-candidates.ts`'s module docblock) — registered separately with a single reachability element so the probe reports "present" before the cascade ever runs. */
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;

/**
 * Verbatim step instruction from the bug report's flow: names the intended
 * control and negates every decoy in one "Do NOT click" clause, matching the
 * exact wording `deep-locator-candidates.test.ts` already pins as the
 * acceptance scenario's `ACCEPTANCE_INSTRUCTION`.
 */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";

/** DOM order the live wizard's "*" hop resolves to: structural container first, "Manual Application" last. */
const LIVE_DECOY_SET = [
  "",
  "Upload a Resume/CV",
  "Use LinkedIn Profile",
  "Upload From Dropbox",
  "Upload From OneDrive",
  "Manual Application",
];

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `observe()` returns `[]` unconditionally — for a
 * hop-scoped selector, an unscoped call, and a top-frame-only call alike —
 * reproducing the measured probe against the live OOPIF (see
 * `flow-runner.iframe-e2e.test.ts`'s `makeFakeStagehandObserveBlind`). `act`
 * mirrors the measured unresolved-instruction-string failure so attempt 1
 * always fails, forcing the cascade into attempt 2's observe-act branch —
 * the one that owns the `resolveDeepLocatorCandidates` ranking under test.
 */
function makeFakeStagehandObserveBlind() {
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: MANUAL_APPLICATION_STEP,
      actions: [],
    }),
    observe: async () => [],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * Minimal fake `Frame`: reachable ONLY via `frame.evaluate`/`frame.locator`,
 * matching a real cross-origin OOPIF where `contentDocument` is `null` from
 * the top frame's script perspective. `location.href` backs onto its own
 * mutable ref so a click inside the iframe navigates the iframe, not the top
 * window, giving the cascade's frame-scoped `urlChanged` verification signal
 * a genuine reason to fire.
 */
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

/**
 * Fake two-frame `Page`: top document's `document.querySelector` resolves the
 * `<iframe>` element's `src` (readable cross-origin), `frames()` exposes the
 * child `Frame`, and `deepLocator()` resolves against the shared
 * `FakeDeepLocatorFrame` registry — the only surface that can see the
 * in-frame decoy set. Includes the CDP-session plumbing `wireSignalCapture`
 * requires, matching every other fixture in this suite family.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      click: async () => {
        await delegate.click();
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
      },
      nth: (index: number) => {
        const inner = fakeDeepLocator(selector);
        const nthDelegate = inner.nth(index);
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

async function runManualApplicationStep(decoyOrder: string[]) {
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
  registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, decoyOrder);
  registerDeepLocatorHop(deepLocatorFrame, PROBE_HOP_SELECTOR, "reachability probe candidate");
  const stagehand = makeFakeStagehandObserveBlind();
  const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

  const result = await runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
    ],
    logger: testLogger,
    anthropic: null,
    uploadFixture: null,
    frameSelector: IFRAME_SELECTOR,
  });

  const hop = deepLocatorFrame.get(HOP_SELECTOR);
  return { result, hop, childUrls };
}

describe("flow-runner OOPIF decoy-set candidate ranking (offline acceptance test, observe blind)", () => {
  it("clicks 'Manual Application' — last in DOM order — over four 'Do NOT click' decoys and a structural container, with observe() blind to the OOPIF", async () => {
    const { result, hop, childUrls } = await runManualApplicationStep(LIVE_DECOY_SET);

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    // biome-ignore lint/style/noNonNullAssertion: the hop was registered above
    const elements = hop!.elements;
    expect(elements[5]?.text).toBe("Manual Application");
    expect(elements[5]?.clicks).toBeGreaterThan(0);
    // None of the container or decoys were clicked — only the ranked target was.
    expect(elements[0]?.clicks).toBe(0);
    expect(elements[1]?.clicks).toBe(0);
    expect(elements[2]?.clicks).toBe(0);
    expect(elements[3]?.clicks).toBe(0);
    expect(elements[4]?.clicks).toBe(0);
  });

  it("negative control: reordering so a decoy sits at index 0 still clicks 'Manual Application', proving the pass above is ranking, not DOM-order luck", async () => {
    const reordered = [
      "Upload From OneDrive",
      "Manual Application",
      "Use LinkedIn Profile",
      "",
      "Upload a Resume/CV",
      "Upload From Dropbox",
    ];
    const { result, hop, childUrls } = await runManualApplicationStep(reordered);

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    // biome-ignore lint/style/noNonNullAssertion: the hop was registered above
    const elements = hop!.elements;
    const manualApplicationIndex = reordered.indexOf("Manual Application");
    expect(elements[manualApplicationIndex]?.clicks).toBeGreaterThan(0);
    for (const [index, element] of elements.entries()) {
      if (index === manualApplicationIndex) continue;
      expect(element.clicks).toBe(0);
    }
  });
});
