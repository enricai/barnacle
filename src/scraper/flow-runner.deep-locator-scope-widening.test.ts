import { describe, expect, it, vi } from "vitest";

import * as deepLocatorCandidatesModule from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import type { FrameCandidateScanResult } from "@/scraper/deep-locator-scan";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance test for the follow-up bug report's over-narrowing risk:
 * `INTERACTIVE_CANDIDATE_SELECTOR` makes a dense OOPIF form's candidate set
 * tractable, but it also matches nothing for a `div`/`span` "tile" that only
 * carries a click handler (no `role`/`tabindex`) — the exact shape a
 * Talemetry-style "Manual Application" card uses. This suite drives the REAL
 * `runHealingFlow` / `resolveFrameTarget` / `guardedObserve` /
 * `resolveDeepLocatorCandidates` stack — only Stagehand and Playwright's
 * `Page`/`Frame` are faked — mirroring
 * `flow-runner.deep-locator-layout-skip.test.ts`'s harness, with a fake
 * child-frame `evaluate` that routes the batched-scan expression to whichever
 * hop its inner selector names, so the interactive-scoped hop and the widened
 * `"*"` hop can be independently populated (or left empty) on the same
 * `FakeDeepLocatorFrame` registry.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const SCOPED_HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
// Also the pre-cascade reachability probe's own hop (`probeStepBeforeAttempts`
// deliberately keeps requesting "*" — see flow-runner.ts's inline comment
// there) — registering a candidate here doubles as "the probe sees content".
const WIDENED_HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;
const MANUAL_APPLICATION_STEP = "Click the 'Manual Application' button.";
const FILL_FIRST_NAME_STEP = "Fill in the First Name field with 'Reginald'";

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
 * that owns the deepLocator widening under test).
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
 * Routes a batched-scan `Frame.evaluate` expression (built by
 * `buildScanFrameCandidatesExpr`) to whichever hop its inner selector names,
 * by checking whether the expression embeds the JSON-quoted
 * `INTERACTIVE_CANDIDATE_SELECTOR` literal — the same `JSON.stringify` call
 * `buildScanFrameCandidatesExpr` itself uses to interpolate the selector, so
 * this is an exact substring match, not a heuristic. A hop with nothing
 * registered resolves to `[]`, modeling "this selector matches zero elements
 * inside the frame".
 */
function routeScanExpression(
  expr: unknown,
  deepLocatorFrame: FakeDeepLocatorFrame
): FrameCandidateScanResult[] {
  const source = String(expr);
  const hopSelector = source.includes(JSON.stringify(INTERACTIVE_CANDIDATE_SELECTOR))
    ? SCOPED_HOP_SELECTOR
    : WIDENED_HOP_SELECTOR;
  const hop = deepLocatorFrame.get(hopSelector);
  if (!hop) return [];
  return hop.elements.map((element, index) => ({
    index,
    text: element.text,
    visible: element.visible,
  }));
}

/**
 * Minimal fake `Frame`: `evaluate` answers `location.href` (so a click inside
 * the iframe can advance it and give the cascade's frame-scoped `urlChanged`
 * verification signal a genuine reason to fire), routes the batched-scan
 * expression through {@link routeScanExpression} against the shared
 * `deepLocatorFrame` registry, and returns `null` for anything else.
 */
function makeFakeChildFrame(
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return childUrls.current;
      if (typeof expr === "string" && expr.includes("querySelectorAll")) {
        return routeScanExpression(expr, deepLocatorFrame);
      }
      return null;
    },
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
 * registry (which also backs {@link routeScanExpression}, so a hop's
 * `click()` state and its batched-scan visibility stay in lockstep). A
 * successful `click()`/`nth(index).click()` advances the child frame's URL —
 * a click against an unregistered hop never reaches that assignment, so only
 * a genuinely resolved-and-clicked candidate gives the cascade a positive
 * verification signal.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls, deepLocatorFrame);
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

async function runManualApplicationStep(
  deepLocatorFrame: FakeDeepLocatorFrame,
  instruction: string = MANUAL_APPLICATION_STEP
) {
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const stagehand = makeFakeStagehandObserveBlind();
  const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

  const resultPromise = runHealingFlow({
    stagehand,
    page,
    steps: [{ instruction, optional: false, upload: false, submitStep: false }],
    logger: testLogger,
    anthropic: null,
    resumeFixture: null,
    frameSelector: IFRAME_SELECTOR,
  });

  return { resultPromise, childUrls };
}

describe("flow-runner/executeStepWithHealing — deepLocator cascade widens the hop when interactive scoping yields no candidates", () => {
  it("clicks a non-semantic clickable tile the widened '*' hop resolves, when the interactive-scoped hop matches nothing", async () => {
    vi.clearAllMocks();

    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    // The scoped hop is deliberately left unregistered: "Manual Application"
    // is a div/span tile with only a click handler — no role/tabindex — so
    // it never matches INTERACTIVE_CANDIDATE_SELECTOR. Only the widened "*"
    // hop resolves it.
    registerDeepLocatorHopElements(deepLocatorFrame, WIDENED_HOP_SELECTOR, ["Manual Application"]);

    const { resultPromise, childUrls } = await runManualApplicationStep(deepLocatorFrame);
    const result = await resultPromise;

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);

    const logged = allLoggedLines();
    expect(logged).toMatch(
      /succeeded on attempt \d+ via observe-act|healed on attempt \d+ via observe-act/
    );
  });
});

describe("flow-runner/executeStepWithHealing — widened '*' enumeration only fires when the interactive-scoped pass is empty", () => {
  it("negative control: a non-empty scoped result clicks the scoped candidate and never enumerates the widened '*' hop", async () => {
    vi.clearAllMocks();

    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(deepLocatorFrame, SCOPED_HOP_SELECTOR, ["Manual Application"]);
    // Registered so the pre-cascade reachability probe (which always asks
    // for "*") reports "present" — its hop selector is identical to the
    // widened one under test, so a decoy candidate here that stays unclicked
    // proves the cascade itself never enumerated this hop, not merely that
    // nothing was registered there to click.
    registerDeepLocatorHopElements(deepLocatorFrame, WIDENED_HOP_SELECTOR, ["Some other tile"]);

    const resolveDeepLocatorCandidatesSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "resolveDeepLocatorCandidates"
    );

    const { resultPromise, childUrls } = await runManualApplicationStep(deepLocatorFrame);
    const result = await resultPromise;

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    expect(deepLocatorFrame.get(SCOPED_HOP_SELECTOR)?.elements[0]?.clicks).toBe(1);
    expect(deepLocatorFrame.get(WIDENED_HOP_SELECTOR)?.elements[0]?.clicks).toBe(0);

    // Instruction-bearing calls are the cascade's own resolves (the probe's
    // reachability call omits the instruction argument, same convention as
    // flow-runner.deep-locator-interactive-scope.test.ts) — exactly one,
    // scoped, proving a non-empty scoped result never triggers a widened
    // "*" enumeration, i.e. Issue #1's throughput win is not silently undone.
    const cascadeCalls = resolveDeepLocatorCandidatesSpy.mock.calls.filter(
      (call) => call[3] !== undefined
    );
    expect(cascadeCalls).toHaveLength(1);
    expect(cascadeCalls[0]?.[2]).toBe(INTERACTIVE_CANDIDATE_SELECTOR);
    expect(cascadeCalls[0]?.[2]).not.toBe("*");

    resolveDeepLocatorCandidatesSpy.mockRestore();
  });
});

describe("flow-runner/executeStepWithHealing — field-label fill/select branch honors the widened hop (bugfix-003 regression)", () => {
  it("fills a labelled field the widened '*' hop resolves against the WIDENED hop, when the interactive-scoped hop matches nothing", async () => {
    vi.clearAllMocks();

    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    // Same over-narrowing shape as the click case: "First Name" never
    // matches INTERACTIVE_CANDIDATE_SELECTOR here (no role/tabindex fixture
    // needed — simply left unregistered), so only the widened "*" hop
    // resolves it, and the fill must land on THAT hop, not a hardcoded
    // INTERACTIVE_CANDIDATE_SELECTOR hop the widened candidate was never
    // indexed against.
    registerDeepLocatorHopElements(deepLocatorFrame, WIDENED_HOP_SELECTOR, ["First Name"]);

    const { resultPromise } = await runManualApplicationStep(
      deepLocatorFrame,
      FILL_FIRST_NAME_STEP
    );
    const result = await resultPromise;

    expect(result.lastStepIndex).toBe(0);
    expect(deepLocatorFrame.get(WIDENED_HOP_SELECTOR)?.elements[0]?.filledWith).toBe("Reginald");
  });

  it("negative control: a non-empty scoped result fills the scoped candidate and never writes to the widened '*' hop", async () => {
    vi.clearAllMocks();

    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(deepLocatorFrame, SCOPED_HOP_SELECTOR, ["First Name"]);
    // Registered so the pre-cascade reachability probe (which always asks
    // for "*") reports "present" — an untouched decoy here proves the fill
    // never even enumerated the widened hop, not merely that nothing there
    // happened to match "First Name".
    registerDeepLocatorHopElements(deepLocatorFrame, WIDENED_HOP_SELECTOR, ["Decoy Field"]);

    const { resultPromise } = await runManualApplicationStep(
      deepLocatorFrame,
      FILL_FIRST_NAME_STEP
    );
    const result = await resultPromise;

    expect(result.lastStepIndex).toBe(0);
    expect(deepLocatorFrame.get(SCOPED_HOP_SELECTOR)?.elements[0]?.filledWith).toBe("Reginald");
    expect(deepLocatorFrame.get(WIDENED_HOP_SELECTOR)?.elements[0]?.filledWith).toBeNull();
  });
});
