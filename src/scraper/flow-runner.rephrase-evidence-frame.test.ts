import type { Anthropic } from "@anthropic-ai/sdk";
import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StagehandModel } from "@/lib/bedrock";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import {
  executeStepWithHealing,
  resetBillingErrorFlagForTests,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const generateObject = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObject(...args),
  };
});

/**
 * Coverage for `deepLocatorCandidatesAsActions` (flow-runner.ts:5162), the
 * module-private adapter that shapes `resolveDeepLocatorCandidates` results
 * into `Action`s for `rephraseWithLLM` when a frame-scoped step's `observe()`
 * comes back empty (call sites at flow-runner.ts:6376/:6396). The adapter
 * isn't exported, so it's exercised indirectly by driving the cascade into
 * its llm-rephrase attempt (a stubbed Anthropic client whose `messages.parse`
 * rejects) and inspecting the rendered prompt `messages.parse` was called
 * with — same "capture the prompt sent to the fake client" technique
 * `flow-runner.step-frame-scope.test.ts` already uses for this branch.
 */

const resolveFrameTarget = vi.fn();
const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: async () => undefined,
  };
});

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const FRAME_SELECTOR = "iframe#apply_frame";
const RADIO_STEP = "Click the 'Yes' answer for the question 'Are you 18 or older?'";

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}` probe so pre/post captures don't throw. */
function makeChildFrameTarget(frame: FrameTarget["frame"]): FrameTarget {
  return {
    frame,
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

function fakeFlowPage(deepLocatorFrame: FakeDeepLocatorFrame): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: () => "https://apply.acme.example/jobs/1/apply",
    title: vi.fn().mockResolvedValue("Apply"),
    deepLocator: makeFakeDeepLocator(deepLocatorFrame),
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

/**
 * Wires the cascade so probeStepBeforeAttempts and attempt 1 both find a
 * candidate/no-op cleanly, and attempts 2/3/4 report no candidates / no
 * prior selector so `shouldSkipTechnique` skips them, landing on attempt 5
 * (llm-rephrase) — the only branch that reaches `deepLocatorCandidatesAsActions`.
 */
function wireCascadeToRephrase(): void {
  guardedObserve
    .mockResolvedValueOnce([{ selector: "input#radio-yes", description: "Yes", method: "click" }])
    .mockResolvedValue([]);
  guardedAct.mockResolvedValue({
    success: false,
    message: "no candidates",
    actionDescription: "",
    actions: [],
  });
}

/**
 * Fake Anthropic client capturing every prompt sent to `messages.parse`,
 * then rejecting so rephraseWithLLM falls back to its documented
 * outcome=impossible path. `extractLivePageFormEvidence`'s invalid-fields/
 * error-messages judges (and `renderUnfocusedObserve`'s modal-priority
 * judge) also call `messages.parse` before `rephraseWithLLM` itself does, so
 * callers must pick the rephrase prompt out of `prompts` by its
 * "ORIGINAL INSTRUCTION:" marker rather than assuming a fixed index.
 */
function makeCapturingAnthropic(): { anthropic: Anthropic; prompts: string[] } {
  const prompts: string[] = [];
  const messagesParse = vi
    .fn()
    .mockImplementation(async (req: { messages: { content: string }[] }) => {
      prompts.push(req.messages[0]?.content ?? "");
      throw new Error("stub judge unavailable");
    });
  return { anthropic: { messages: { parse: messagesParse } } as unknown as Anthropic, prompts };
}

/**
 * Wires the `ai` package's `generateObject` (rephraseWithLLM's own call,
 * distinct from the judges' `messages.parse` calls captured above) to
 * record the rendered prompt and reject, so the cascade falls back to its
 * documented outcome=impossible path just like the Anthropic-SDK stub did.
 */
function wireRephraseModel(prompts: string[]): StagehandModel {
  generateObject.mockImplementation(async (req: { prompt: string }) => {
    prompts.push(req.prompt);
    throw new Error("stub rephrase model unavailable");
  });
  return { modelId: "test-model" } as unknown as StagehandModel;
}

function findRephrasePrompt(prompts: string[]): string {
  const rephrasePrompt = prompts.find((p) => p.includes("ORIGINAL INSTRUCTION:"));
  if (rephrasePrompt === undefined) {
    throw new Error(`no rephrase prompt found among ${prompts.length} captured prompt(s)`);
  }
  return rephrasePrompt;
}

describe("flow-runner/executeStepWithHealing — llm-rephrase deepLocatorCandidatesAsActions evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("populates rephrase evidence from deepLocator candidates, shaped as click Actions, when observe is empty for a child frame", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, hopSelector, ["Manual Application"]);

    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget({} as FrameTarget["frame"]));
    wireCascadeToRephrase();
    const { anthropic, prompts } = makeCapturingAnthropic();
    const rephraseModel = wireRephraseModel(prompts);

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page: fakeFlowPage(frame),
        steps: [{ instruction: RADIO_STEP, optional: false, upload: false, submitStep: false }],
        logger: testLogger,
        anthropic,
        rephraseModel,
        uploadFixture: null,
        frameSelector: FRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(prompts.length).toBeGreaterThan(0);
    const rephrasePrompt = findRephrasePrompt(prompts);
    // deepLocatorCandidatesAsActions maps {selector: "deeplocator=<hop> >> nth=0", description: "Manual Application", method: "click"};
    // rephraseWithLLM renders each Action as "N. <description> — <selector>" in its candidate list.
    expect(rephrasePrompt).toContain(`1. Manual Application — deeplocator=${hopSelector} >> nth=0`);
  });

  it("falls back to the literal '(no accessible text)' description for a deepLocator candidate with blank text", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, hopSelector, [""]);

    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget({} as FrameTarget["frame"]));
    wireCascadeToRephrase();
    const { anthropic, prompts } = makeCapturingAnthropic();
    const rephraseModel = wireRephraseModel(prompts);

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page: fakeFlowPage(frame),
        steps: [{ instruction: RADIO_STEP, optional: false, upload: false, submitStep: false }],
        logger: testLogger,
        anthropic,
        rephraseModel,
        uploadFixture: null,
        frameSelector: FRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(prompts.length).toBeGreaterThan(0);
    const rephrasePrompt = findRephrasePrompt(prompts);
    expect(rephrasePrompt).toContain(
      `1. (no accessible text) — deeplocator=${hopSelector} >> nth=0`
    );
  });

  it("never calls deepLocator for rephrase evidence when frameTarget.frame is null (main-frame fallback)", async () => {
    const deepLocatorSpy = vi.fn();
    resolveFrameTarget.mockResolvedValue({
      frame: null,
      frameSelector: FRAME_SELECTOR,
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn(),
      url: () => Promise.resolve("https://apply.acme.example/jobs/1/apply"),
      title: () => Promise.resolve("Apply"),
    } satisfies FrameTarget);
    wireCascadeToRephrase();
    const { anthropic, prompts } = makeCapturingAnthropic();
    const rephraseModel = wireRephraseModel(prompts);

    const page = fakeFlowPage(new Map());
    (page as unknown as { deepLocator: unknown }).deepLocator = deepLocatorSpy;

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: [{ instruction: RADIO_STEP, optional: false, upload: false, submitStep: false }],
        logger: testLogger,
        anthropic,
        rephraseModel,
        uploadFixture: null,
        frameSelector: FRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(deepLocatorSpy).not.toHaveBeenCalled();
    expect(prompts.length).toBeGreaterThan(0);
    const rephrasePrompt = findRephrasePrompt(prompts);
    expect(rephrasePrompt).toContain("(no candidates returned by observe)");
  });

  it("still issues the rephrase LLM call with empty deepLocator evidence, within the watchdog budget, when the child-frame deepLocator hop never settles", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    const { release } = registerDeepLocatorHangingHop(frame, hopSelector, { hangOn: "count" });

    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget({} as FrameTarget["frame"]));
    wireCascadeToRephrase();
    const { anthropic, prompts } = makeCapturingAnthropic();
    const rephraseModel = wireRephraseModel(prompts);

    // deepLocatorCandidatesAsActions never threads a timeoutOptions override
    // through to resolveDeepLocatorCandidates, so every count() on this hop
    // rides out the resolver's real 10s default per-call watchdog before
    // degrading to [] — this test's wall-clock cost is the guard actually
    // proving itself, not a stand-in for it.
    try {
      await expect(
        runHealingFlow({
          stagehand: makeStagehand(),
          page: fakeFlowPage(frame),
          steps: [{ instruction: RADIO_STEP, optional: false, upload: false, submitStep: false }],
          logger: testLogger,
          anthropic,
          rephraseModel,
          uploadFixture: null,
          frameSelector: FRAME_SELECTOR,
        })
      ).rejects.toThrow(/failed verification after \d+ attempts/);
    } finally {
      release();
    }

    expect(prompts.length).toBeGreaterThan(0);
    const rephrasePrompt = findRephrasePrompt(prompts);
    expect(rephrasePrompt).toContain("(no candidates returned by observe)");
  }, 90_000);
});

/**
 * Coverage for bugfix-001's form-value-diff signal (flow-runner.ts's
 * `formValueVerified`, gated on `STATE_CLASS_METHODS`). Drives
 * `executeStepWithHealing` directly (not `runHealingFlow`) so the returned
 * `AttemptRecord[]` exposes `verifiedBy` — the only way to prove the fill
 * verified via `"form-value"` specifically, rather than merely completing.
 *
 * This file's top-level `vi.mock("@/scraper/stagehand-guard")` routes every
 * `executeStepWithHealing` call through the module-level `guardedObserve`/
 * `guardedAct` mocks (not `stagehand.observe`/`stagehand.act` directly) —
 * these tests wire those, not the `Stagehand` fake's own methods.
 *
 * The fake page's `locator().first().inputValue()` deliberately answers
 * "" (never containing the filled value), so `verifyDomEffect` — the
 * existing `domVerified` check that reads the SAME selector `fill` acted
 * on — returns false. Only `evaluate`'s `DOM_SNAPSHOT_EXPR` reply (the
 * `values` field bugfix-001 added) reflects the write. This isolates the
 * value-diff signal: if `formValueSignature` weren't OR'd into `verified`,
 * this step would report failed verification exactly like the bug
 * report's plain "Phone Number" field.
 */
describe("flow-runner/executeStepWithHealing — form-value-diff signal (bugfix-001)", () => {
  const FILL_STEP = "Fill in the Phone Number field with '(212) 555-0123'";
  const FILL_SELECTOR = "input#phone";
  const FILL_VALUE = "(212) 555-0123";

  function fillActResult(): ActResult {
    return {
      success: true,
      message: "filled",
      actionDescription: FILL_STEP,
      actions: [{ selector: FILL_SELECTOR, description: "Phone Number", method: "fill" }],
    };
  }

  function wireProbeCandidate(): void {
    guardedObserve.mockResolvedValue([
      { selector: FILL_SELECTOR, description: "Phone Number", method: "fill" },
    ]);
  }

  /**
   * `formValues` starts as "" and flips to `FILL_VALUE` once `stagehand.act`
   * resolves — matching how the write genuinely lands on the page even
   * though `locator().inputValue()` (the pre-existing `domVerified` read)
   * stays blind to it here, same as `verifyDomEffect`'s own bug-report
   * false-negative. `evaluate`'s DOM_SNAPSHOT_EXPR reply is the ONLY
   * channel through which the fill becomes observable.
   */
  function fakePage(formValues: { current: string }): Page {
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes('querySelectorAll("input, textarea, select")')) {
        return { html: 1000, text: "4:test", values: formValues.current };
      }
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    return {
      evaluate,
      url: () => "https://apply.acme.example/jobs/1/apply",
      title: vi.fn().mockResolvedValue("Apply"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
  }

  function baseParams(page: Page) {
    const stagehand = {} as unknown as Stagehand;
    return {
      stagehand,
      page,
      step: FILL_STEP,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: true,
      stepIndex: 3,
      phase: "apply",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      captureFn: vi.fn().mockResolvedValue(undefined),
      uploadFixture: null,
      isFinalStep: false,
      submitEndpointPattern: null,
      submittedStateSelectors: [],
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("verifies a plain-input fill with zero network/url/text-content effect via form-value diff", async () => {
    wireProbeCandidate();
    const formValues = { current: "" };
    guardedAct.mockImplementation(async () => {
      formValues.current = FILL_VALUE;
      return fillActResult();
    });
    const page = fakePage(formValues);
    const onStepFailure = vi.fn().mockReturnValue(null);
    const params = { ...baseParams(page), onStepFailure };

    const result = await executeStepWithHealing(params);

    // `page.locator(...).inputValue()` always answers "" (never containing
    // FILL_VALUE), so `verifyDomEffect`'s own read-back — the pre-existing
    // domVerified signal — cannot be what verified this step; only the
    // evaluate()-sourced formValueSignature diff (bugfix-001) can.
    expect(result).toBe("completed");
    expect(onStepFailure).not.toHaveBeenCalled();
    expect(guardedAct).toHaveBeenCalledTimes(1);
  });

  it("still reports unverified when the fill is a no-op (value never changes)", async () => {
    wireProbeCandidate();
    const formValues = { current: "" };
    // Reports success but never actually writes the field — no network, no
    // URL change, no text-content change, and now no form-value change
    // either, so nothing should credit this as verified.
    guardedAct.mockResolvedValue(fillActResult());
    const page = fakePage(formValues);
    const onStepFailure = vi.fn().mockReturnValue(null);
    const params = { ...baseParams(page), onStepFailure };

    await expect(executeStepWithHealing(params)).rejects.toThrow(
      /failed verification after \d+ attempts/
    );

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const attempts = onStepFailure.mock.calls[0]?.[0].attempts;
    const attempt1 = attempts.find((a: { attempt: number }) => a.attempt === 1);
    expect(attempt1?.verifiedBy).toBeNull();
  });
});
