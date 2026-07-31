import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins the run-6-into-run-5 half of the bug report: `resolveFrameTarget`'s
 * step-entry poll loses the attach race and returns a main-frame fallback,
 * but the OOPIF is bound by the time the cascade reaches its deepLocator
 * gates. `resolveFrameTarget` is mocked at the module boundary (matching
 * `flow-runner.deep-locator-fallback.test.ts`'s style) rather than driven
 * through a fake `page.frames()` timeline (`flow-runner.frame-reresolve.test.ts`'s
 * style) so the two calls can be sequenced deterministically: fallback on the
 * step-entry call, a bound child target on every re-resolution afterward. A
 * single-resolution-at-step-entry implementation calls `resolveFrameTarget`
 * once, keeps `frameTarget.frame` pinned to `null` for the whole step, and
 * every deepLocator gate below stays closed — the hop's click counters never
 * move off 0.
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

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
/** The cascade's attempt-2/4 branch resolves candidates at the interactive-scoped hop (bugfix-005). */
const HOP_SELECTOR = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** `probeStepBeforeAttempts` deliberately keeps requesting `"*"` (a reachability gate, not the candidate set the cascade acts on — see `deep-locator-candidates.ts`'s module docblock); this suite's probe falls through to its own deepLocator check, so it needs a hop registered here too. */
const PROBE_HOP_SELECTOR = `${FRAME_SELECTOR} >> *`;

/** Fake `.locator()` surface every `FrameTarget` needs for the checkbox/select primitives that run before the probe. */
function fakeLocator() {
  return vi.fn().mockReturnValue({
    first: () => ({
      isChecked: vi.fn().mockResolvedValue(false),
      inputValue: vi.fn().mockResolvedValue(""),
    }),
  });
}

/**
 * The step-entry `FrameTarget` when `resolveFrameTarget` loses the attach
 * race: `frame: null` (main-frame-scoped) with `declaredFrameSelector` set —
 * `reresolveFrameTargetIfLost`'s gate (`flow-runner.ts`) reads exactly this
 * field to decide whether a re-resolution is worth attempting.
 */
function makeMainFrameFallback(): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    declaredFrameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue(null),
    locator: fakeLocator(),
    url: () => Promise.resolve("https://apply.acme.example/jobs/1/apply"),
    title: () => Promise.resolve("Apply"),
  };
}

/** The bound child-frame `FrameTarget` a later `resolveFrameTarget` call resolves to once the OOPIF has attached. */
function makeChildFrameTarget(urls: { current: string }): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    declaredFrameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: fakeLocator(),
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

describe("flow-runner — frame re-resolved right before the deepLocator probe (run 6 → run 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("late-attaching OOPIF still reaches page.deepLocator and clicks the instruction-ranked candidate", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame: FakeDeepLocatorFrame = new Map();
    // Index 0 is an empty-text structural container, index 1 a decoy button —
    // "Manual Application" (the step's actual target) resolves last, so a
    // click at index 0 (unranked DOM order) would prove nothing about the
    // instruction-ranking half of the contract.
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      "",
      "Upload a Resume/CV",
      "Manual Application",
    ]);
    registerDeepLocatorHopElements(frame, PROBE_HOP_SELECTOR, ["Manual Application"]);
    const deepLocator = makeFakeDeepLocator(frame);
    const wrappedDeepLocator = (selector: string) => {
      const delegate = deepLocator(selector);
      return {
        ...delegate,
        click: async () => {
          await delegate.click();
          urls.current = "https://apply.acme.example/jobs/1/apply/manual";
        },
        nth: (index: number) => {
          const inner = deepLocator(selector);
          const nthDelegate = inner.nth(index);
          return {
            ...nthDelegate,
            click: async () => {
              await nthDelegate.click();
              urls.current = "https://apply.acme.example/jobs/1/apply/manual";
            },
          };
        },
      };
    };
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: wrappedDeepLocator,
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Apply"),
      locator: fakeLocator(),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    } as unknown as Page;

    // Step-entry call loses the attach race and falls back to the main
    // frame; every re-resolution attempt after that (the deepLocator-gate
    // fix under test) sees the OOPIF bound.
    resolveFrameTarget
      .mockResolvedValueOnce(makeMainFrameFallback())
      .mockResolvedValue(makeChildFrameTarget(urls));

    // Focused AND unfocused observe both empty on every call — probe falls
    // through past both observe checks to its own deepLocator gate, and
    // attempt 1 (act) resolves nothing, landing the cascade on attempt 2's
    // observe-act deepLocator branch, the one whose click counters this test
    // asserts against.
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no actionable candidate",
      actionDescription: "",
      actions: [],
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction:
            "Click 'Manual Application' to skip the resume-upload flow. Do NOT click 'Upload a Resume/CV'.",
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
    const hop = frame.get(HOP_SELECTOR);
    expect(hop?.elements[0]?.clicks).toBe(0);
    expect(hop?.elements[1]?.clicks).toBe(0);
    expect(hop?.elements[2]?.clicks).toBeGreaterThan(0);
  });
});
