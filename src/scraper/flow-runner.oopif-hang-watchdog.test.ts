import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Acceptance regression locking in the plan's minimum milestone: a
 * frame-scoped step whose deepLocator calls (or whose frame-attach probe)
 * wedge must fail fast to the next attempt/replan within the watchdog
 * window instead of hanging for ~78 minutes with zero attempt logs — the
 * run-6 shape from the top-window site report. Unlike
 * `flow-runner.deep-locator-hang.test.ts` (which `vi.mock`s
 * `@/scraper/stagehand-guard` and `@/scraper/frame-target`), this file
 * drives the REAL `runHealingFlow` / `resolveFrameTarget` /
 * `guardedObserve` / `guardedAct` stack end to end — only Stagehand and
 * Playwright's `Page`/`Frame` are faked — matching
 * `flow-runner.oopif-candidate-ranking.test.ts`'s harness, so the guards
 * under test (deepLocator's per-call watchdog from bugfix-002,
 * frame-target's evaluate deadline from bugfix-003/005/006) are exercised
 * through their real call sites rather than mocked away.
 */

const { moduleLoggerStub } = vi.hoisted(() => ({
  moduleLoggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
// `resolveFrameTarget`'s "did not attach" warning goes through
// `@/scraper/frame-target`'s own module-level logger (`getLogger(...)` at
// import time), NOT the `logger` param threaded through `runHealingFlow` —
// so asserting on it requires stubbing `@/lib/logging` itself, same pattern
// as `frame-resolve.test.ts`.
vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return {
    ...actual,
    getLogger: () => moduleLoggerStub,
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      scraper: {
        ...actual.config.scraper,
        frameReadyTimeoutMs: 30,
        frameEvaluateTimeoutMs: 20,
        frameDocumentReadyTimeoutMs: 20,
      },
    },
  };
});

import {
  type FakeDeepLocatorFrame,
  type FakeDeepLocatorHangingHop,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { advanceUntilSettled } from "@/scraper/fake-timer-advance";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example.com";
const IFRAME_SELECTOR = "iframe#apply_frame";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's attempt-2/4 branch resolves candidates at the interactive-scoped hop (bugfix-005), not `"*"`; the pre-cascade probe never reaches deepLocator in this suite (see `makeFakeStagehandObserveBlind`'s unfocused-observe short-circuit), so only this hop needs the hang gate. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
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
 * Advances the fake clock well past every deepLocator per-call watchdog the
 * cascade's 5 attempts could hit (10s default, `deep-locator-candidates.ts`),
 * in many small steps rather than a few large ones, stopping as soon as
 * `resultPromise` settles instead of always running the full tick budget
 * (`@/scraper/fake-timer-advance`'s `advanceUntilSettled`). Sinon's
 * fake-clock `tickAsync` (which `advanceTimersByTimeAsync` wraps) only
 * drains a bounded number of microtask turns per call; the real
 * `guardedObserve`/`guardedAct`/`resolveDeepLocatorCandidates` stack this
 * suite drives (unlike the `vi.mock`-based
 * `flow-runner.deep-locator-hang.test.ts`) chains far more awaits per
 * attempt than that bound allows in one shot, so a handful of 10s jumps
 * stalls partway through — many 1s jumps give the queue enough chances to
 * fully drain between each timer step. (A `vi.getTimerCount() > 0`-gated
 * loop stepping one pending timer at a time via
 * `advanceTimersToNextTimerAsync` was tried: it measurably deadlocks
 * instead — the timer count can read 0 between real fires even though the
 * cascade's continuation hasn't yet scheduled its next watchdog, so the
 * loop exits before every attempt has run and `await assertion` hangs
 * forever waiting on a fake timer nothing is advancing anymore.)
 */
async function advancePastDeepLocatorHangs(resultPromise: Promise<unknown>): Promise<void> {
  await advanceUntilSettled(resultPromise, {
    advanceTimersByTimeAsync: vi.advanceTimersByTimeAsync,
  });
}

/**
 * Fake `Stagehand` whose `observe()` is blind for every FOCUSED (string
 * instruction) call but finds a harmless candidate for the UNFOCUSED
 * (no-instruction) call — matching run 6's own diagnostic ("unfocused
 * observe found 65 top-frame candidates"). This routes
 * `probeStepBeforeAttempts` to "present" via its unfocused fallback WITHOUT
 * ever touching `deepLocator`/the frame-attach probe itself, so each case
 * below exercises its own guard only through the cascade's attempts, not
 * the pre-cascade probe. `act` resolves a candidate but reports no
 * observable effect, so attempt 1 fails without succeeding (forcing the
 * cascade into attempt 2's observe-act branch — the one that owns the
 * deepLocator gate) while still emitting attempt 1's own log line (an empty
 * `actions` array short-circuits that log — see
 * `flow-runner.deep-locator-hang.test.ts`'s beforeEach comment).
 */
function makeFakeStagehandObserveBlind() {
  return {
    act: async () => ({
      success: false,
      message: "no observable effect",
      actionDescription: MANUAL_APPLICATION_STEP,
      actions: [
        { selector: "xpath=//body", description: "attempt candidate click", method: "click" },
      ],
    }),
    observe: async (instructionOrOptions?: unknown) =>
      typeof instructionOrOptions === "string"
        ? []
        : [{ selector: "body", description: "page body", method: "click" }],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

function makeFakeChildFrame(childUrls: { current: string }) {
  return {
    // `document.readyState` answers "complete" so `waitForChildFrameReady`
    // resolves on its first probe instead of polling out its real deadline —
    // that poll uses `sleep()` (a genuine `setTimeout`), which would otherwise
    // need its own fake-timer advances unrelated to the deepLocator hang
    // under test in this file.
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return childUrls.current;
      if (expr === "document.readyState") return "complete";
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
 * Fake two-frame `Page` whose OOPIF is bound from the very first poll
 * (`frames()` returns the child immediately, and the top document's
 * `document.querySelector` resolves the `<iframe>` element's `src` on the
 * first call) — the run-5 shape where the frame won the attach race —
 * except `deepLocator()` resolves against `deepLocatorFrame`, a registry
 * this suite seeds with a HANGING hop so the cascade's deepLocator gate
 * wedges instead of the frame-attach probe.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
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
    deepLocator: makeFakeDeepLocator(deepLocatorFrame),
  } as unknown as import("@browserbasehq/stagehand").Page;
}

describe("flow-runner OOPIF-bound deepLocator hang (offline acceptance test, real stack)", () => {
  let hangingHop: FakeDeepLocatorHangingHop | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    hangingHop?.release();
    hangingHop = undefined;
    vi.useRealTimers();
  });

  it("fails fast to the next attempt/replan instead of hanging when a bound OOPIF's deepLocator count() never settles", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    hangingHop = registerDeepLocatorHangingHop(deepLocatorFrame, HOP_SELECTOR, {
      hangOn: "count",
    });
    const stagehand = makeFakeStagehandObserveBlind();
    const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

    const resultPromise = runHealingFlow({
      stagehand,
      page,
      // submitStep: true keeps this step submit-shaped under
      // flowHasSubmitSemantics (bugfix-005) so attempt 2's phantom-click
      // escalation still takes the deep-submit-locator branch this test
      // exercises, instead of the trusted-click-retry branch a plain
      // read-only final step now takes.
      steps: [
        {
          instruction: MANUAL_APPLICATION_STEP,
          optional: false,
          upload: false,
          submitStep: true,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      /failed verification after \d+ attempts/
    );

    await advancePastDeepLocatorHangs(resultPromise);
    await assertion;

    const logged = allLoggedLines();
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
  });

  it("fails fast to the next attempt/replan instead of hanging when a bound OOPIF's deepLocator click() never settles", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    hangingHop = registerDeepLocatorHangingHop(deepLocatorFrame, HOP_SELECTOR, {
      hangOn: "click",
      text: "Manual Application",
    });
    const stagehand = makeFakeStagehandObserveBlind();
    const page = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

    const resultPromise = runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: MANUAL_APPLICATION_STEP,
          optional: false,
          upload: false,
          submitStep: true,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      /failed verification after \d+ attempts/
    );

    await advancePastDeepLocatorHangs(resultPromise);
    await assertion;

    const logged = allLoggedLines();
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
  });
});

describe("flow-runner frame-attach probe hang (offline acceptance test, real stack)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast to the next attempt/replan instead of hanging when the top-frame page.evaluate probing for the OOPIF never settles", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const session = { on: () => {}, off: () => {} };
    const stagehand = makeFakeStagehandObserveBlind();
    const page = {
      // Only the frame-attach probe's `document.querySelector(...)` expression
      // wedges — every other `page.evaluate` call (signal capture, dump
      // bodyOuterHtml, etc.) resolves normally, isolating the guard under
      // test (frame-target's per-call watchdog + attach deadline) from the
      // rest of the cascade's machinery.
      evaluate: async (expr: unknown) =>
        /document\.querySelector\(/.test(String(expr)) ? new Promise(() => {}) : null,
      url: () => topUrl.current,
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
      frames: () => [],
    } as unknown as import("@browserbasehq/stagehand").Page;

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [
          {
            instruction: MANUAL_APPLICATION_STEP,
            optional: false,
            upload: false,
            submitStep: true,
          },
        ],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: IFRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    const frameTargetWarnings = moduleLoggerStub.warn.mock.calls.map((call) => String(call[0]));
    expect(frameTargetWarnings).toContainEqual(
      expect.stringMatching(new RegExp(`frame ${IFRAME_SELECTOR} did not attach within \\d+ms`))
    );

    const logged = allLoggedLines();
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
  });
});
