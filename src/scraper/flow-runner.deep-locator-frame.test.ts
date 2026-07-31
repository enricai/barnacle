import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeDeepLocatorDelegate } from "@/scraper/deep-locator-fake";
import { makeFakeDeepLocator, registerDeepLocatorHop } from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Acceptance-level regression test for the bug report's "Manual Application"
 * failure mode: `observe()` is blind to a cross-origin OOPIF (measured on
 * Stagehand 3.7.0 and 3.7.1 — see `deep-locator-candidates.ts`'s module
 * docblock), so a frame-scoped step whose target lives inside that iframe
 * used to exhaust the cascade even though the element is genuinely present
 * and `page.deepLocator()` resolves it. This file drives the full
 * `runHealingFlow` cascade end-to-end (rather than unit-testing
 * `probeStepBeforeAttempts` in isolation, which
 * `flow-runner.deep-locator-fallback.test.ts` already owns) so a regression
 * that reintroduces the observe-only dependency fails this acceptance
 * contract even if the narrower unit tests are edited alongside it.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();
const waitForChildFrameReady = vi.fn().mockResolvedValue(undefined);

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: (...args: unknown[]) => waitForChildFrameReady(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** `stagehand.act`/`stagehand.observe` are never called directly — flow-runner calls the mocked `guardedAct`/`guardedObserve` — so this only needs to be a distinct, identifiable object passed through untouched. */
function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const STEP_INSTRUCTION = "Click the Manual Application button";

/**
 * Child `FrameTarget` whose `evaluate` answers `snapshotPage`'s `{html,text}`
 * probe so the pre/post captures around each attempt don't throw. `getUrl`
 * backs `url()` with a mutable value so a click that advances the wizard
 * gives `snapshotPage`'s `post.url !== pre.url` check (the cascade's
 * `urlChanged` verification signal) a real reason to fire.
 */
function makeChildFrameTarget(getUrl: () => string): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve(getUrl()),
    title: () => Promise.resolve("Apply"),
  };
}

/** Main-frame `FrameTarget` mirroring `mainFrameTarget`'s real contract: `frame: null`, delegates straight to `page`. Used for the control case proving the deepLocator fallback is frame-gated. */
function makeMainFrameTarget(page: Page): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    evaluate: (pageFunctionOrExpression, arg) => page.evaluate(pageFunctionOrExpression, arg),
    locator: (selector) => page.locator(selector),
    url: () => Promise.resolve(page.url()),
    title: () => page.title(),
  };
}

/**
 * Fake page satisfying `wireSignalCapture`'s CDP plumbing plus the plain
 * evaluate/locator surface. `deepLocatorImpl` lets each test swap in a
 * registry-backed fake (frame-scoped success) or an empty one (control case),
 * while still routing through the same object shape flow-runner expects.
 */
function fakeFlowPage(
  getUrl: () => string,
  deepLocatorImpl: (selector: string) => FakeDeepLocatorDelegate
): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    deepLocator: deepLocatorImpl,
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

describe("flow-runner/runHealingFlow — OOPIF cascade regression (observe-blind, deepLocator-sighted)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("resolves and clicks the frame-scoped step via deepLocator when observe() finds nothing, and records a deeplocator=-shaped selector", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHop(frame, hopSelector, "Manual Application");
    // probeStepBeforeAttempts deliberately keeps requesting "*" (a
    // reachability gate, not the candidate set the cascade acts on — see
    // deep-locator-candidates.ts's module docblock), so it needs its own hop
    // registered to report "present" before the cascade runs.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "Manual Application");
    const baseDeepLocator = makeFakeDeepLocator(frame);
    // `resolveDeepLocatorCandidates`/`clickDeepLocatorCandidate` both compose
    // their hop scope via `page.deepLocator(hopSelector)` then chain
    // `.nth(index)` — capturing both the outer selector `deepLocator()` was
    // called with and the `index` that reached `.click()` reconstructs
    // exactly the `deeplocator=<hop> >> nth=<i>` shape `candidateSelector()`
    // synthesizes for the resolvedAction (pinned independently at the
    // resolver level in deep-locator-candidates.test.ts), without needing
    // flow-runner to leak its internal `AttemptRecord`. Also wraps `click()`
    // to advance the URL so the cascade's urlChanged verification signal has
    // a real reason to fire.
    const deepLocatorSelectors: string[] = [];
    const clickedIndexes: number[] = [];
    const wrappedDeepLocator = (selector: string): FakeDeepLocatorDelegate => {
      deepLocatorSelectors.push(selector);
      const delegate = baseDeepLocator(selector);
      const wrap = (index: number, d: FakeDeepLocatorDelegate): FakeDeepLocatorDelegate => ({
        ...d,
        click: async () => {
          clickedIndexes.push(index);
          await d.click();
          urls.current = "https://apply.acme.example/jobs/1/apply/manual";
        },
        nth: (nextIndex: number) => wrap(nextIndex, d.nth(nextIndex)),
      });
      return wrap(0, delegate);
    };
    const page = fakeFlowPage(() => urls.current, wrappedDeepLocator);

    resolveFrameTarget.mockImplementation(async () => makeChildFrameTarget(() => urls.current));
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: STEP_INSTRUCTION,
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    const hop = frame.get(hopSelector);
    expect(hop?.clicks).toBe(1);
    expect(deepLocatorSelectors).toContain(hopSelector);
    expect(clickedIndexes).toEqual([0]);
    // The recorded resolvedAction selector is `deeplocator=${hopSelector} >>
    // nth=${index}` — asserting the click landed on the hop scope at index 0
    // proves the action synthesized for verification is this deeplocator=-shaped,
    // hop-composed selector rather than an observe()-style CSS/a11y selector.
    const recordedSelector = `deeplocator=${hopSelector} >> nth=${clickedIndexes[0]}`;
    expect(recordedSelector).toBe(
      `deeplocator=iframe#talemetry_apply_iframe >> ${INTERACTIVE_CANDIDATE_SELECTOR} >> nth=0`
    );
  });

  it("control: a main-frame target with observe()=[] still yields the pre-existing absent/skip behavior and never calls deepLocator", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const deepLocatorSpy = vi.fn();
    const page = fakeFlowPage(() => urls.current, deepLocatorSpy);

    resolveFrameTarget.mockImplementation(async () => makeMainFrameTarget(page));
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: [
          {
            instruction: STEP_INSTRUCTION,
            optional: false,
            upload: false,
            submitStep: false,
          },
        ],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: undefined,
      })
    ).rejects.toThrow(/probe found no candidates/);

    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });
});
