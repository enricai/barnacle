import { describe, expect, it, vi } from "vitest";

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
 * Offline acceptance test for the bug report's Issue #2: a deepLocator hop
 * whose top-ranked candidate has no layout box (the CDP `-32000 Node does
 * not have a layout object` click failure) used to be scored as the whole
 * attempt's failure — `flow-runner.ts` only ever clicked
 * `deepLocatorCandidates[0]`. This suite drives the REAL `runHealingFlow` /
 * `resolveFrameTarget` / `guardedObserve` / `resolveDeepLocatorCandidates`
 * stack — only Stagehand and Playwright's `Page`/`Frame` are faked —
 * mirroring `flow-runner.oopif-candidate-ranking.test.ts`'s harness, with a
 * fake child-frame `evaluate` that doesn't answer the batched-scan
 * expression so `resolveDeepLocatorCandidates` degrades to its legacy
 * per-candidate loop, which (unlike the batched scan) does not pre-filter
 * unrendered candidates — the exact path that lets a layout-less node reach
 * the click cascade instead of being screened out at enumeration time.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
// `probeStepBeforeAttempts` deliberately keeps asking for `"*"` (a
// reachability-only gate), so the probe resolves against its own hop while
// the cascade under test resolves against the interactive-scoped one —
// same split as flow-runner.oopif-candidate-ranking.test.ts.
const PROBE_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;
const MANUAL_APPLICATION_STEP = "Click the 'Manual Application' button.";

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const testLogger = {
  info: loggerInfo,
  warn: loggerWarn,
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Concatenates every info/warn call's message so a single regex can scan across both. */
function allLoggedLines(): string {
  return [...loggerInfo.mock.calls, ...loggerWarn.mock.calls]
    .map((call) => String(call[0]))
    .join("\n");
}

/**
 * Fake Stagehand whose `observe()` returns `[]` unconditionally — reproducing
 * the measured probe against a cross-origin OOPIF — and whose `act` mirrors
 * the measured unresolved-instruction-string failure so attempt 1 always
 * fails, forcing the cascade into attempt 2's observe-act branch (the one
 * that owns the deepLocator click cascade under test).
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
 * Minimal fake `Frame`: `evaluate` answers ONLY `location.href` (so a click
 * inside the iframe can advance it and give the cascade's frame-scoped
 * `urlChanged` verification signal a genuine reason to fire) and returns
 * `null` for anything else — including the batched-scan expression, which
 * routes `resolveDeepLocatorCandidates` to its legacy per-candidate loop
 * instead of the visibility-pre-filtered batched path.
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
 * `<iframe>` element's `src`, `frames()` exposes the child `Frame`, and
 * `deepLocator()` resolves against the shared `FakeDeepLocatorFrame`
 * registry. A successful `click()`/`nth(index).click()` advances the child
 * frame's URL — a click that throws (the layout-less candidate) never
 * reaches that assignment, so only a genuinely successful click gives the
 * cascade a positive verification signal.
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

async function runManualApplicationStep(elements: Array<{ text: string; visible?: boolean }>) {
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
  registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
  registerDeepLocatorHop(deepLocatorFrame, PROBE_HOP_SELECTOR, "reachability probe candidate");
  const stagehand = makeFakeStagehandObserveBlind();
  const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

  const resultPromise = runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
    ],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    frameSelector: IFRAME_SELECTOR,
  });

  const hop = deepLocatorFrame.get(HOP_SELECTOR);
  return { resultPromise, hop, childUrls };
}

describe("flow-runner/executeStepWithHealing — deepLocator branch skips a layout-less candidate for the next-ranked one", () => {
  it("clicks the runner-up when the top-ranked candidate rejects with the CDP -32000 layout-object error, and does not record the skip as a failed click", async () => {
    vi.clearAllMocks();

    // Both candidates match the step's instruction equally (same accessible
    // text), so ranking ties on score and falls back to original DOM/delegate
    // order — index 0 (layout-less) ranks first, index 1 (rendered) is the
    // runner-up. This is the falsifying shape: a naive top-only pick would
    // click index 0, throw -32000, and never try index 1.
    const { resultPromise, hop, childUrls } = await runManualApplicationStep([
      { text: "Manual Application", visible: false },
      { text: "Manual Application", visible: true },
    ]);

    const result = await resultPromise;

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    expect(hop?.elements[1]?.clicks).toBe(1);
    expect(hop?.elements[0]?.clicks).toBe(0);

    const logged = allLoggedLines();
    // The cascade skipped the not-actionable candidate silently instead of
    // scoring it as the attempt's failure — no "click threw" reason for a
    // -32000 rejection should ever surface in the attempt log.
    expect(logged).not.toMatch(/deepLocator: click threw/);
    // The step resolved via the cascade's observe-act branch, not by
    // exhausting into a later technique.
    expect(logged).toMatch(
      /succeeded on attempt \d+ via observe-act|healed on attempt \d+ via observe-act/
    );
  });

  it("negative control: when every candidate is layout-less, the cascade terminates without an infinite retry loop, records a clear reason, and falls through to the next attempt", async () => {
    vi.clearAllMocks();

    const { resultPromise, hop } = await runManualApplicationStep([
      { text: "Manual Application", visible: false },
      { text: "Manual Application", visible: false },
      { text: "Manual Application", visible: false },
    ]);

    await expect(resultPromise).rejects.toThrow(/failed verification after \d+ attempts/);

    // biome-ignore lint/style/noNonNullAssertion: the hop was registered above
    for (const element of hop!.elements) {
      expect(element.clicks).toBe(0);
    }

    const logged = allLoggedLines();
    // Every candidate was not-actionable — the cascade exhausted cleanly with
    // a legible reason instead of hanging or silently swallowing the attempt.
    expect(logged).toMatch(/deepLocator: no actionable candidate/);
    // Exhausting the deepLocator branch on attempt 2 falls through to the
    // rest of the cascade (structured-click, attempt 4's exclusion retry,
    // llm-rephrase) rather than aborting the whole step early. Attempt 1
    // (act-string) resolves no candidate here and fast-skips without its own
    // log line — see flow-runner.deep-locator-hang.test.ts's beforeEach
    // comment for the same shape — so only attempts 2-5 are asserted.
    for (const attempt of [2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
  });
});
