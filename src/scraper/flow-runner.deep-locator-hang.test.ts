import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeDeepLocatorFrame,
  type FakeDeepLocatorHangingHop,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for run 6 of the uchealth deepLocator-hang report: a
 * frame-scoped step whose `page.deepLocator(...).count()`/`.click()` never
 * settle must still fail the cascade's attempts (via the `withWatchdog` guard
 * added in bugfix-002) instead of producing zero attempt logs for ~78 minutes.
 *
 * Mirrors run 6's own diagnostic shape: the pre-cascade probe goes "present"
 * via an UNFOCUSED observe (the real run's "unfocused observe found 65
 * top-frame candidates" line) so it never touches `deepLocator` itself —
 * only the cascade's attempt-2/attempt-4 branch (flow-runner.ts:6033-6098)
 * does, which is what this suite is scoped to (see investigation_notes).
 * A `guardedObserve` mock returning candidates ONLY for the unfocused
 * (`instruction === undefined`) call reproduces this split.
 *
 * Uses fake timers throughout: flow-runner.ts's deepLocator call sites don't
 * pass `timeoutOptions`, so they always run against
 * `deep-locator-candidates.ts`'s un-overridable 10s default per-call
 * watchdog — waiting that out for real (twice, once per hung attempt) would
 * needlessly burn wall-clock and risk flaking under CI load.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();

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
    waitForChildFrameReady: async () => undefined,
  };
});

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const testLogger = {
  info: loggerInfo,
  warn: loggerWarn,
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
/** The cascade's attempt-2/4 branch resolves candidates at the interactive-scoped hop (bugfix-005), not `"*"`. */
const HOP_SELECTOR = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;

function makeChildFrameTarget(urls: { current: string }): FrameTarget {
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
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(urls: { current: string }, frame: FakeDeepLocatorFrame): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    deepLocator: makeFakeDeepLocator(frame),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

/** Concatenates every `info`/`warn` call's message so a single regex can scan across both. */
function allLoggedLines(): string {
  return [...loggerInfo.mock.calls, ...loggerWarn.mock.calls]
    .map((call) => String(call[0]))
    .join("\n");
}

describe("flow-runner/executeStepWithHealing — deepLocator hang (run 6 regression)", () => {
  let hangingHop: FakeDeepLocatorHangingHop | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    vi.useFakeTimers();
    // Focused observe (the probe's first call, and every cascade observe-act
    // call — both pass `step` as the instruction) finds nothing; only the
    // probe's UNFOCUSED follow-up (instruction === undefined) does, matching
    // run 6's own diagnostic ("unfocused observe found 65 top-frame
    // candidates"). This keeps the probe off the deepLocator path entirely,
    // so the hang under test is exercised only by the cascade's attempt 2/4.
    guardedObserve.mockImplementation((_stagehand: unknown, instruction: unknown) =>
      Promise.resolve(
        instruction === undefined
          ? [{ selector: "xpath=//body", description: "unfocused candidate", method: "click" }]
          : []
      )
    );
    // Attempt 1's act-string call resolves a candidate but doesn't verify
    // (unlike the sibling deep-locator-fallback suite, which leaves
    // `actions: []` to fast-skip attempt 1 without a logger call) so this
    // suite's per-attempt log trail — the exact signal run 6's report says
    // went silent — covers all 5 attempts, not just 2-5.
    guardedAct.mockResolvedValue({
      success: false,
      message: "no observable effect",
      actionDescription: "attempt 1 candidate click",
      actions: [
        { selector: "xpath=//body", description: "attempt 1 candidate click", method: "click" },
      ],
    });
  });

  afterEach(() => {
    hangingHop?.release();
    hangingHop = undefined;
    vi.useRealTimers();
  });

  it("fast-fails the cascade instead of hanging when deepLocator's count() never settles", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame: FakeDeepLocatorFrame = new Map();
    hangingHop = registerDeepLocatorHangingHop(frame, HOP_SELECTOR, { hangOn: "count" });
    const page = makeFakePage(urls, frame);
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));

    const resultPromise = runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the Manual Application button",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      /failed verification after \d+ attempts/
    );

    // Attempts 2 and 4 each call resolveDeepLocatorCandidates, whose count()
    // hangs and is bounded by deep-locator-candidates.ts's 10s per-call
    // default. Advance past both serially-scheduled watchdogs.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await assertion;

    const logged = allLoggedLines();
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
    expect(logged).toMatch(/observe returned no candidates/);
  });

  it("fast-fails the cascade instead of hanging when deepLocator's click() never settles after a candidate resolves", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame: FakeDeepLocatorFrame = new Map();
    hangingHop = registerDeepLocatorHangingHop(frame, HOP_SELECTOR, { hangOn: "click" });
    const page = makeFakePage(urls, frame);
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));

    const resultPromise = runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the Manual Application button",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      /failed verification after \d+ attempts/
    );

    // count()/textContent() settle instantly here (only click() hangs), so
    // only attempt 2's click() watchdog needs advancing — attempt 4's
    // exclusion filter removes the only candidate before it would click again.
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await assertion;

    const logged = allLoggedLines();
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(logged).toMatch(new RegExp(`attempt ${attempt}\\b`));
    }
    expect(logged).toMatch(/deepLocator: click threw/);
  });
});
