import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as deepLocatorCandidatesModule from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import {
  probeStepBeforeAttempts,
  resetBillingErrorFlagForTests,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Behavioral coverage for the frame-scoped deepLocator fallback added to the
 * three observe-blind call sites (probe, attempt-2/4 observe-act, and — by
 * omission here since it only feeds prompt evidence — llm-rephrase). Uses
 * the shared `deep-locator-fake` harness rather than the module-boundary
 * `vi.mock` style other frame suites use, since these assertions are about
 * `page.deepLocator()` itself being reached with the right hop selector and
 * candidate exclusion, not about which `FrameTarget`/`evaluate` call a DOM
 * primitive dispatched through.
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

const FRAME_SELECTOR = "iframe#apply_frame";

/** Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}` probe so pre/post captures don't throw. */
function makeChildFrameTarget(): FrameTarget {
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
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
}

describe("flow-runner/probeStepBeforeAttempts — frame-scoped deepLocator fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns present when observe is empty (focused+unfocused) but deepLocator resolves >=1 candidate for a child frame", async () => {
    guardedObserve.mockResolvedValue([]);
    const frame = new Map();
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
    const page = {
      deepLocator: makeFakeDeepLocator(frame),
      url: () => "https://apply.example.com/application/abc-123",
    } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: makeChildFrameTarget(),
    });

    expect(result).toBe("present");
  });

  it("probes with no instruction argument, unlike the act/rephrase deepLocator call sites (deep-locator-candidates.ts:130-132: omitting instruction skips ranking, which is correct for a reachability-only check)", async () => {
    guardedObserve.mockResolvedValue([]);
    const frame: FakeDeepLocatorFrame = new Map();
    // Text unrelated to the step instruction: ranking never filters
    // candidates (only reorders — deep-locator-candidates.ts:161), so this
    // alone can't distinguish "instruction omitted" from "instruction
    // forwarded" via the `present`/`absent` outcome. The instruction-arg
    // assertion below is what actually pins the contract; this proves the
    // outcome is unaffected by text relevance either way.
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> *`, [
      "Upload a Resume/CV",
      "Cancel",
    ]);
    const page = {
      deepLocator: makeFakeDeepLocator(frame),
      url: () => "https://apply.example.com/application/abc-123",
    } as unknown as Page;
    const resolveDeepLocatorCandidatesSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "resolveDeepLocatorCandidates"
    );

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: makeChildFrameTarget(),
    });

    expect(result).toBe("present");
    // Passes the already-resolved frameTarget (5th-arg { frameTarget }) so
    // the batched evaluate reuses it instead of re-resolving internally —
    // the instruction arg (4th) stays undefined, same reachability-only
    // contract as before.
    expect(resolveDeepLocatorCandidatesSpy).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      "*",
      undefined,
      { frameTarget: expect.objectContaining({ frameSelector: FRAME_SELECTOR }) }
    );
    resolveDeepLocatorCandidatesSpy.mockRestore();
  });

  it("returns absent when observe AND deepLocator both find nothing for a child frame", async () => {
    guardedObserve.mockResolvedValue([]);
    const page = { deepLocator: makeFakeDeepLocator(new Map()) } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: makeChildFrameTarget(),
    });

    expect(result).toBe("absent");
  });

  it('resolves "absent" within the resolver\'s watchdog budget when the child-frame deepLocator hop hangs on count(), instead of hanging the probe (run-6 78-minute-hang regression)', async () => {
    vi.useFakeTimers();
    try {
      guardedObserve.mockResolvedValue([]);
      const frame: FakeDeepLocatorFrame = new Map();
      const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> *`, {
        hangOn: "count",
      });
      const page = { deepLocator: makeFakeDeepLocator(frame) } as unknown as Page;

      const probePromise = probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page,
        step: "Click Manual Application",
        stepIndex: 0,
        logger: testLogger,
        frameTarget: makeChildFrameTarget(),
      });

      // Sentinel race: with count() still wedged and the fake clock
      // untouched, the probe must not have settled yet — proves the
      // assertion below actually exercises the watchdog timeout rather than
      // some unrelated synchronous short-circuit.
      const stillPending = Symbol("still-pending");
      await expect(Promise.race([probePromise, Promise.resolve(stillPending)])).resolves.toBe(
        stillPending
      );

      // Advances past deep-locator-candidates.ts's per-call watchdog budget
      // (10s default), which degrades the wedged count() to 0 instead of
      // hanging forever — the probe then falls through to "absent".
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(probePromise).resolves.toBe("absent");

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call deepLocator when frameTarget.frame is null (main-frame path stays byte-identical)", async () => {
    guardedObserve.mockResolvedValue([]);
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: undefined,
    });

    expect(result).toBe("absent");
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("does not call deepLocator when resolveFrameTarget fell back to the main frame (frame: null) despite a frameSelector", async () => {
    guardedObserve.mockResolvedValue([]);
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy } as unknown as Page;
    const fallbackTarget: FrameTarget = {
      frame: null,
      frameSelector: FRAME_SELECTOR,
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn(),
      url: () => Promise.resolve("https://apply.acme.example/jobs/1/apply"),
      title: () => Promise.resolve("Apply"),
    };

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: fallbackTarget,
    });

    expect(result).toBe("absent");
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — frame-scoped deepLocator attempt-2 click path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("clicks the deepLocator candidate and synthesizes a deeplocator=-shaped resolvedAction that verifies via urlChanged", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHop(frame, hopSelector);
    // probeStepBeforeAttempts deliberately keeps requesting "*" (a
    // reachability gate, not the candidate set the cascade acts on), so it
    // needs its own hop registered to report "present" before the cascade
    // (which resolves candidates at the interactive-scoped hop above) runs.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
    const deepLocator = makeFakeDeepLocator(frame);
    // Wrap the fake delegate's click to also advance the URL, giving the
    // cascade's urlChanged verification signal a real reason to fire.
    const wrappedDeepLocator = (selector: string) => {
      const delegate = deepLocator(selector);
      return {
        ...delegate,
        click: async () => {
          await delegate.click();
          urls.current = "https://apply.acme.example/jobs/1/apply/manual";
        },
        nth: () => wrappedDeepLocator(selector),
      };
    };
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: wrappedDeepLocator,
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
    resolveFrameTarget.mockResolvedValue({
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
    } satisfies FrameTarget);

    // Focused+unfocused observe both empty on every call (probe AND attempt
    // 2), so probeStepBeforeAttempts falls through to the deepLocator probe
    // (finds the candidate, returns "present") and attempt 1 (act-string via
    // guardedAct) also resolves nothing, landing the cascade on attempt 2's
    // observe-act branch — the one under test.
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
          instruction: "Click the Manual Application button",
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
    expect(hop?.clicks).toBeGreaterThan(0);
  });

  it("clicks the instruction-relevant candidate, not index 0, when the child frame holds decoys plus the intended button", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    // Index 0 is an empty-text structural container (the interactive-scoped
    // hop's realistic DOM-order top pick); "Manual Application" — the step's
    // actual target — resolves last. Pre-bugfix-003, deepLocatorCandidates[0]
    // would click the container; with instruction threaded through, ranking
    // must put "Manual Application" first regardless of DOM position.
    registerDeepLocatorHopElements(frame, hopSelector, [
      "",
      "Upload a Resume/CV",
      "Manual Application",
    ]);
    // probeStepBeforeAttempts deliberately keeps requesting "*" — see the
    // sibling test above.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
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
    resolveFrameTarget.mockResolvedValue({
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
    } satisfies FrameTarget);

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
    const hop = frame.get(hopSelector);
    expect(hop?.elements[0]?.clicks).toBe(0);
    expect(hop?.elements[1]?.clicks).toBe(0);
    expect(hop?.elements[2]?.clicks).toBeGreaterThan(0);
  });

  it("excludes an already-tried deepLocator selector on attempt 4 instead of re-picking it", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    // Only ONE element resolves at this hop scope (index 0). Attempt 2 will
    // click it and fail to verify (URL never changes), so triedSelectors
    // carries its synthesized `xpath=...nth=0` selector into attempt 4 —
    // proving the exclusion filters it out rather than re-clicking the same
    // dead candidate.
    registerDeepLocatorHop(frame, hopSelector);
    // probeStepBeforeAttempts deliberately keeps requesting "*" — see the
    // first test in this describe block.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
    const clickSpy = vi.fn();
    const deepLocator = makeFakeDeepLocator(frame);
    const wrappedDeepLocator = (selector: string) => {
      const delegate = deepLocator(selector);
      return {
        ...delegate,
        click: async () => {
          clickSpy(selector);
          await delegate.click();
          // Deliberately does NOT change the URL — this candidate never
          // verifies, so it stays in triedSelectors for attempt 4 to see.
        },
        nth: () => wrappedDeepLocator(selector),
      };
    };
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: wrappedDeepLocator,
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
    resolveFrameTarget.mockResolvedValue({
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
    } satisfies FrameTarget);

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
            instruction: "Click the Manual Application button",
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
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Attempt 2 clicks the only candidate once; attempt 4's exclusion filter
    // then has nothing left to click, so the total click count stays at 1
    // instead of clicking the same dead candidate again.
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("escalates a non-submit attempt-1 phantom click to trusted-click-retry, whose trusted CDP click registers the selection", async () => {
    // Attempt 1 (act-string) reports success but produces no observable effect
    // — a phantom on a design-system button whose handler ignored the untrusted
    // in-page click. That routes attempt 2 to trusted-click-retry, which
    // re-resolves the target and clicks it via the trusted deepLocator().nth()
    // .click() — modeled here as the click that finally flips the URL.
    const urls = { current: "https://apply.acme.example/onboard/a/2" };
    const frame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, hopSelector, ["Just started looking"]);
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
    let advanceCounter = 2;
    const deepLocator = makeFakeDeepLocator(frame);
    const wrappedDeepLocator = (selector: string) => {
      const delegate = deepLocator(selector);
      return {
        ...delegate,
        nth: (index: number) => {
          const nthDelegate = deepLocator(selector).nth(index);
          return {
            ...nthDelegate,
            click: async () => {
              await nthDelegate.click();
              // Each trusted click advances the wizard to a fresh URL, so both
              // the target step and the trailing step verify via url change.
              advanceCounter += 1;
              urls.current = `https://apply.acme.example/onboard/a/${advanceCounter}`;
            },
          };
        },
      };
    };
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: wrappedDeepLocator,
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Onboard"),
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
    resolveFrameTarget.mockResolvedValue({
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
      title: () => Promise.resolve("Onboard"),
    } satisfies FrameTarget);

    guardedObserve.mockResolvedValue([]);
    // Step 1's attempt-1 act-string: Stagehand believes it clicked (success +
    // a resolved action) but the wrapped deepLocator did NOT run, so pre/post is
    // flat — a phantom click that routes attempt 2 to trusted-click-retry.
    // The trailing step's act-string genuinely advances the URL (a real click),
    // so it verifies on its own attempt 1 and never confuses this assertion.
    guardedAct.mockImplementation(async (_sh: unknown, instruction: string) => {
      if (instruction.includes("Dismiss")) {
        advanceCounter += 1;
        urls.current = `https://apply.acme.example/onboard/a/${advanceCounter}`;
        return {
          success: true,
          message: "dismissed",
          actionDescription: "dismiss",
          actions: [{ selector: "xpath=/button[9]", description: "dismiss", method: "click" }],
        };
      }
      return {
        success: true,
        message: "clicked",
        actionDescription: "Just started looking button",
        actions: [
          { selector: "xpath=/button[1]", description: "Just started looking", method: "click" },
        ],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the 'Just started looking' button",
          optional: false,
          upload: false,
          submitStep: false,
        },
        {
          // A trailing OPTIONAL step so the target step above is NOT the final
          // step — isFinalStep would otherwise mark it submit-shaped and route
          // its phantom to deep-submit-locator instead of trusted-click-retry.
          instruction: "Dismiss any confirmation dialog if present",
          optional: true,
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

    expect(result.lastStepIndex).toBe(1);
    // The trusted-click-retry's CDP click on the resolved candidate is what
    // advanced the URL — the phantom attempt-1 click never touched the delegate.
    expect(urls.current).toBe("https://apply.acme.example/onboard/a/4");
    const hop = frame.get(hopSelector);
    expect(hop?.elements[0]?.clicks).toBeGreaterThan(0);
  });
});

describe("flow-runner/executeStepWithHealing — top-window trusted-click-retry (no frame seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("escalates a non-submit attempt-1 phantom click to a trusted top-window locator click when no frame seam exists", async () => {
    // A design-system wizard rendered in the TOP window (same-origin, no
    // cross-origin OOPIF): resolveFrameTarget falls back to the main-frame
    // target (frame: null) and the deepLocator path (built entirely on a frame
    // seam) yields nothing. Attempt 1 (act-string) reports success but produces
    // no observable effect — a phantom on a design-system button whose handler
    // ignored the untrusted in-page click — routing attempt 2 to
    // trusted-click-retry. Before the top-window fix this bailed with "no frame
    // seam available"; now it must re-click attempt-1's resolved xpath through
    // the main-frame FrameTarget's trusted `.locator().first().click()`.
    const urls = { current: "https://apply.acme.example/onboard/a/1" };
    const topWindowClick = vi.fn(async () => {
      urls.current = "https://apply.acme.example/onboard/a/2";
    });
    const clickedSelectors: string[] = [];
    const page = {
      evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Onboard"),
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
    // Main-frame target: frame is null (the no-seam condition under test), and
    // `.locator()` records the selector and delegates to the trusted-click spy.
    resolveFrameTarget.mockResolvedValue({
      frame: null,
      frameSelector: null,
      evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
      locator: vi.fn().mockImplementation((selector: string) => ({
        first: () => ({
          click: async () => {
            clickedSelectors.push(selector);
            await topWindowClick();
          },
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      })),
      url: () => Promise.resolve(urls.current),
      title: () => Promise.resolve("Onboard"),
    } satisfies FrameTarget);

    // Probe's focused observe finds the button so the step is "present" (a
    // top-window page has no frame seam for the probe's deepLocator fallback).
    // Attempt 2 is trusted-click-retry (the phantom branch), so this candidate
    // never feeds an observe-act attempt.
    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//button[normalize-space()='Just started looking']",
        description: "Just started looking",
        method: "click",
      },
    ]);
    guardedAct.mockImplementation(async (_sh: unknown, instruction: string) => {
      if (instruction.includes("Dismiss")) {
        urls.current = "https://apply.acme.example/onboard/a/3";
        return {
          success: true,
          message: "dismissed",
          actionDescription: "dismiss",
          actions: [{ selector: "xpath=//button[9]", description: "dismiss", method: "click" }],
        };
      }
      // Phantom: success + a resolved xpath, but no URL/DOM/network movement.
      return {
        success: true,
        message: "clicked",
        actionDescription: "Just started looking button",
        actions: [
          {
            selector: "xpath=//button[normalize-space()='Just started looking']",
            description: "Just started looking",
            method: "click",
          },
        ],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the 'Just started looking' button",
          optional: false,
          upload: false,
          submitStep: false,
        },
        {
          instruction: "Dismiss any confirmation dialog if present",
          optional: true,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(1);
    // The trusted top-window locator click fired on attempt-1's resolved xpath
    // and advanced the URL — the phantom attempt-1 click never moved it.
    expect(clickedSelectors).toContain("xpath=//button[normalize-space()='Just started looking']");
    expect(topWindowClick).toHaveBeenCalled();
  });

  it("re-clicks attempt-1's FIRST resolved xpath (the phantomed target), not the last, when act resolved multiple actions", async () => {
    // Attempt-1 act resolves two actions: the FIRST is the phantomed target
    // (what resolvedAction binds to and classifyPhantomClick judged), the
    // SECOND an unrelated decoy pushed later into triedSelectors. The
    // trusted-click-retry must re-click the FIRST — a last-entry heuristic
    // would click the decoy and never activate the real control.
    const targetXpath = "xpath=//button[normalize-space()='Just started looking']";
    const decoyXpath = "xpath=//button[normalize-space()='Some other control']";
    const urls = { current: "https://apply.acme.example/onboard/a/1" };
    const clickedSelectors: string[] = [];
    const page = {
      evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Onboard"),
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
    resolveFrameTarget.mockResolvedValue({
      frame: null,
      frameSelector: null,
      evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
      locator: vi.fn().mockImplementation((selector: string) => ({
        first: () => ({
          click: async () => {
            clickedSelectors.push(selector);
            // Only a click on the correct (first) target advances the URL, so
            // the step verifies iff the FIRST xpath was chosen.
            if (selector === targetXpath) {
              urls.current = "https://apply.acme.example/onboard/a/2";
            }
          },
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      })),
      url: () => Promise.resolve(urls.current),
      title: () => Promise.resolve("Onboard"),
    } satisfies FrameTarget);

    guardedObserve.mockResolvedValue([
      { selector: targetXpath, description: "Just started looking", method: "click" },
    ]);
    guardedAct.mockImplementation(async (_sh: unknown, instruction: string) => {
      if (instruction.includes("Dismiss")) {
        urls.current = "https://apply.acme.example/onboard/a/3";
        return {
          success: true,
          message: "dismissed",
          actionDescription: "dismiss",
          actions: [{ selector: "xpath=//button[9]", description: "dismiss", method: "click" }],
        };
      }
      // Phantom: success, first action is the real target, second a decoy.
      return {
        success: true,
        message: "clicked",
        actionDescription: "Just started looking button",
        actions: [
          { selector: targetXpath, description: "Just started looking", method: "click" },
          { selector: decoyXpath, description: "Some other control", method: "click" },
        ],
      };
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click the 'Just started looking' button",
          optional: false,
          upload: false,
          submitStep: false,
        },
        {
          instruction: "Dismiss any confirmation dialog if present",
          optional: true,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(1);
    expect(clickedSelectors).toContain(targetXpath);
    expect(clickedSelectors).not.toContain(decoyXpath);
  });
});
