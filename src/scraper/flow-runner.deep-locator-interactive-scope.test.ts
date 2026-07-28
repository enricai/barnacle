import type { Anthropic } from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as deepLocatorActuateModule from "@/scraper/deep-locator-actuate";
import * as deepLocatorCandidatesModule from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import {
  type AttemptRecord,
  executeStepWithHealing,
  probeStepBeforeAttempts,
  resetBillingErrorFlagForTests,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Positive, argument-level coverage that every flow-runner call site which
 * feeds the healing cascade scopes its deepLocator hop to
 * `INTERACTIVE_CANDIDATE_SELECTOR` instead of `"*"` — the fix for the
 * uchealth-7 371-candidate/4.6s-per-round-trip enumeration cost. The
 * existing deepLocator suites (`flow-runner.deep-locator-fallback.test.ts`,
 * `flow-runner.rephrase-evidence-frame.test.ts`) only prove this
 * *behaviorally*, by registering the fake harness's hop at the scoped
 * selector so a call still using `"*"` would silently resolve nothing; none
 * of them spy on `resolveDeepLocatorCandidates`/`clickDeepLocatorCandidate`
 * to assert the argument itself. This file closes that gap for the three
 * seams that reach the resolver — attempt-2/4 observe-act, rephrase-evidence,
 * and the pre-cascade probe — and additionally pins the probe's *intentional*
 * exception: it keeps requesting `"*"` (a cheap reachability-only gate,
 * documented at flow-runner.ts's `probeStepBeforeAttempts`), so that
 * exception reads as a deliberate, tested design decision rather than an
 * accidental miss.
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

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/**
 * Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}`
 * probe so pre/post captures don't throw. `url` defaults to a fixed string
 * for the probe-only scenarios; the attempt-2/4 click scenario passes a
 * closure over its mutable `urls.current` so the frame target's own URL
 * reflects the click-driven navigation the same way `page.url()` does —
 * otherwise the cascade's urlChanged verification signal never fires.
 */
function makeChildFrameTarget(
  frame: FrameTarget["frame"] = {} as FrameTarget["frame"],
  url: () => Promise<string> = () =>
    Promise.resolve("https://apply.talemetry.com/application/abc-123")
): FrameTarget {
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
    url,
    title: () => Promise.resolve("Apply"),
  };
}

describe("flow-runner deepLocator call sites — scoped to interactive elements, not '*'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("probe seam (probeStepBeforeAttempts): deliberately keeps requesting '*', not the interactive selector — a documented exception, not an oversight", async () => {
    guardedObserve.mockResolvedValue([]);
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> *`, ["Upload a Resume/CV"]);
    const page = { deepLocator: makeFakeDeepLocator(frame) } as unknown as Page;
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
    expect(resolveDeepLocatorCandidatesSpy).toHaveBeenCalledTimes(1);
    const [, , innerSelector] = resolveDeepLocatorCandidatesSpy.mock.calls[0] ?? [];
    expect(innerSelector).toBe("*");
    expect(innerSelector).not.toBe(INTERACTIVE_CANDIDATE_SELECTOR);
    resolveDeepLocatorCandidatesSpy.mockRestore();
  });

  it("attempt-2/4 observe-act seam: resolveDeepLocatorCandidates is scoped to INTERACTIVE_CANDIDATE_SELECTOR (button, a, input, select, textarea, [role=button], [tabindex]), and clickDeepLocatorCandidate re-derives the SAME hop", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHop(frame, scopedHopSelector, "Manual Application");
    // Only the probe's own "*" hop needs registering separately (see the
    // sibling probe-seam test above) — it deliberately keeps requesting "*"
    // so it needs a candidate at that scope to report "present" before the
    // cascade (which resolves at the interactive-scoped hop above) runs.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "Manual Application");
    const deepLocator = makeFakeDeepLocator(frame);
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
    resolveFrameTarget.mockResolvedValue(
      makeChildFrameTarget({} as FrameTarget["frame"], () => Promise.resolve(urls.current))
    );

    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const resolveDeepLocatorCandidatesSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "resolveDeepLocatorCandidates"
    );
    const clickDeepLocatorCandidateSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "clickDeepLocatorCandidate"
    );

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
      resumeFixture: null,
      frameSelector: FRAME_SELECTOR,
    });
    expect(result.lastStepIndex).toBe(0);

    // The probe's own "*" call (instruction arg omitted) is a distinct seam
    // (see the sibling test above) — filter it out so this assertion is
    // scoped to the attempt-2/4 observe-act enumeration call, which always
    // forwards the step instruction as its 4th arg.
    const cascadeEnumerationCalls = resolveDeepLocatorCandidatesSpy.mock.calls.filter(
      (call) => call[3] !== undefined
    );
    expect(cascadeEnumerationCalls.length).toBeGreaterThan(0);
    for (const call of cascadeEnumerationCalls) {
      expect(call[2]).toBe(INTERACTIVE_CANDIDATE_SELECTOR);
      expect(call[2]).not.toBe("*");
    }

    expect(clickDeepLocatorCandidateSpy).toHaveBeenCalledTimes(1);
    const clickCall = clickDeepLocatorCandidateSpy.mock.calls[0] ?? [];
    const clickInnerSelector = clickCall[2];
    expect(clickInnerSelector).toBe(INTERACTIVE_CANDIDATE_SELECTOR);
    // Index-space consistency: clickDeepLocatorCandidate re-derives its hop
    // from (frameSelector, innerSelector), so the click must reuse the exact
    // innerSelector the enumeration ranked candidates against — otherwise
    // `top.index` would be re-applied against a differently-ordered hop and
    // silently click the wrong element.
    expect(clickInnerSelector).toBe(cascadeEnumerationCalls[0]?.[2]);

    resolveDeepLocatorCandidatesSpy.mockRestore();
    clickDeepLocatorCandidateSpy.mockRestore();
  });

  it("rephrase-evidence seam (deepLocatorCandidatesAsActions): resolveDeepLocatorCandidates is scoped to INTERACTIVE_CANDIDATE_SELECTOR when the llm-rephrase attempt gathers evidence for a frame-scoped step", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, scopedHopSelector, ["Manual Application"]);

    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget());
    // Attempt 1 finds a candidate via observe (no-op success path skipped by
    // guardedAct below); every later observe call comes back empty so the
    // cascade falls through act-string, observe-act, observe-act-exclude,
    // and deep-submit-locator without ever verifying, landing on attempt 5
    // (llm-rephrase) — the only technique that reaches
    // `deepLocatorCandidatesAsActions`. Same wiring as
    // flow-runner.rephrase-evidence-frame.test.ts.
    guardedObserve
      .mockResolvedValueOnce([{ selector: "input#radio-yes", description: "Yes", method: "click" }])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const prompts: string[] = [];
    const anthropic = {
      messages: {
        parse: vi.fn().mockImplementation(async (req: { messages: { content: string }[] }) => {
          prompts.push(req.messages[0]?.content ?? "");
          throw new Error("stub judge unavailable");
        }),
      },
    } as unknown as Anthropic;

    const resolveDeepLocatorCandidatesSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "resolveDeepLocatorCandidates"
    );

    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      url: () => "https://apply.acme.example/jobs/1/apply",
      title: vi.fn().mockResolvedValue("Apply"),
      deepLocator: makeFakeDeepLocator(frame),
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

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: [
          {
            instruction: "Click the 'Yes' answer for the question 'Are you 18 or older?'",
            optional: false,
            upload: false,
            submitStep: false,
          },
        ],
        logger: testLogger,
        anthropic,
        resumeFixture: null,
        frameSelector: FRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Every step-instruction-bearing call (the probe's own reachability "*"
    // call omits the instruction arg — see the sibling probe-seam test) must
    // be scoped to the interactive selector, never the bare "*".
    const instructionBearingCalls = resolveDeepLocatorCandidatesSpy.mock.calls.filter(
      (call) => call[3] !== undefined
    );
    expect(instructionBearingCalls.length).toBeGreaterThan(0);
    for (const call of instructionBearingCalls) {
      expect(call[2]).toBe(INTERACTIVE_CANDIDATE_SELECTOR);
      expect(call[2]).not.toBe("*");
    }

    // Independent confirmation the scoped call is what fed the rephrase
    // prompt: the candidate text only resolves at the interactive-scoped hop
    // registered above, so its presence in the prompt proves the evidence
    // came from that call, not a coincidental empty "*" enumeration.
    expect(prompts.length).toBeGreaterThan(0);
    const rephrasePrompt = prompts.find((p) => p.includes("ORIGINAL INSTRUCTION:"));
    expect(rephrasePrompt).toContain(
      `Manual Application — deeplocator=${scopedHopSelector} >> nth=0`
    );

    resolveDeepLocatorCandidatesSpy.mockRestore();
  });
});

/**
 * bugfix-003: the deepLocator attempt-2/4 branch used to hand every ranked
 * candidate straight to `clickFirstActionableCandidate`'s click callback,
 * even for a "Fill in the X field with 'Y'" or "Select 'Y' in the X
 * dropdown" step — at best clicking the field and never filling/selecting
 * it. These cases prove the branch now discriminates fill/select/click from
 * the step's own prose (there is no Stagehand-resolved `target.method` to
 * read here, unlike the observe path) and routes to the matching
 * actuation seam.
 *
 * Every case below drives `executeStepWithHealing` directly (the function
 * named in this subtask's acceptance criteria) with `observe()` blind for
 * every attempt — the OOPIF condition this whole cascade exists for — so
 * the deepLocator fallback is the only path that can ever resolve a
 * candidate. A fill/select step matched to a named field routes through
 * `findDeepLocatorCandidateByFieldLabel` straight to
 * `deep-locator-actuate.ts`'s read-back-verified seam, which records
 * `verifiedBy: "dom"` directly (`verifyDomEffect` can't resolve a
 * `deeplocator=`-prefixed selector via `target.locator()`, so the read-back
 * itself is the only verification signal available) — so a successful
 * fill/select now resolves the step outright instead of exhausting the
 * cascade. A plain click step has no such read-back signal, so it still
 * exhausts and rejects; what's under test there is the ACTUATION that
 * happened during the attempt, captured via the spied seams and the
 * `onStepFailure` dump's `attempts[]` (same pattern the sibling
 * rephrase-evidence test above uses).
 */
describe("flow-runner deepLocator actuation routing — fill/select/click discrimination (bugfix-003)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });
  });

  function makeDeepLocatorPage(frame: FakeDeepLocatorFrame): Page {
    return {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: makeFakeDeepLocator(frame),
      url: () => "https://apply.acme.example/jobs/1/apply",
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

  function runStep(page: Page, step: string, onFailureAttempts: AttemptRecord[][]) {
    return executeStepWithHealing({
      stagehand: makeStagehand(),
      page,
      frameTarget: makeChildFrameTarget(),
      step,
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 0,
      totalSteps: () => 1,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      logger: testLogger,
      resumeFixture: null,
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
      onStepFailure: ({ attempts }) => {
        onFailureAttempts.push(attempts);
        return null;
      },
    });
  }

  it("fill step: actuates fillDeepLocatorCandidate (not click), with the value parsed from the step, and synthesizes resolvedAction.method='fill'", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, scopedHopSelector, ["First Name"]);
    // The pre-cascade probe (`probeStepBeforeAttempts`) deliberately keeps
    // requesting the unscoped "*" hop (see the sibling test above) — it
    // needs a candidate registered there too, or it declares the step
    // "absent" before the attempt loop (and this branch) ever runs.
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "First Name");
    const page = makeDeepLocatorPage(frame);

    const fillSpy = vi.spyOn(deepLocatorActuateModule, "fillDeepLocatorCandidate");
    const selectSpy = vi.spyOn(deepLocatorActuateModule, "selectDeepLocatorCandidateOption");
    const clickSpy = vi.spyOn(deepLocatorCandidatesModule, "clickDeepLocatorCandidate");
    const attemptsByFailure: AttemptRecord[][] = [];

    // The field-label fast path (findDeepLocatorCandidateByFieldLabel) routes
    // straight to the read-back-verified actuation seam, which records
    // verifiedBy: "dom" on a successful write — so the step now resolves
    // "completed" outright instead of exhausting the cascade.
    await expect(
      runStep(page, "Fill in the First Name field with 'Reginald'", attemptsByFailure)
    ).resolves.toBe("completed");

    expect(fillSpy).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      0,
      "Reginald"
    );
    expect(selectSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();

    expect(frame.get(scopedHopSelector)?.filledWith).toBe("Reginald");

    fillSpy.mockRestore();
    selectSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("select step: actuates selectDeepLocatorCandidateOption (not click) with the option parsed from the step, and synthesizes resolvedAction.method='selectOption'", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, scopedHopSelector, ["Country"]);
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "Country");
    const page = makeDeepLocatorPage(frame);

    const fillSpy = vi.spyOn(deepLocatorActuateModule, "fillDeepLocatorCandidate");
    const selectSpy = vi.spyOn(deepLocatorActuateModule, "selectDeepLocatorCandidateOption");
    const clickSpy = vi.spyOn(deepLocatorCandidatesModule, "clickDeepLocatorCandidate");
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      runStep(page, "Select 'United States' in the Country dropdown", attemptsByFailure)
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(selectSpy).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      0,
      "United States"
    );
    expect(fillSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();

    const attempts = attemptsByFailure[0] ?? [];
    const deepLocatorAttempt = attempts.find((a) => a.resolvedMethod === "selectOption");
    expect(deepLocatorAttempt?.actResultSuccess).toBe(true);
    expect(deepLocatorAttempt?.resolvedArguments).toEqual(["United States"]);

    expect(frame.get(scopedHopSelector)?.selectedWith).toEqual(["United States"]);

    fillSpy.mockRestore();
    selectSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("a not-actionable (-32000) rejection on a fill still advances to the next ranked candidate across attempts, and the step ultimately completes", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    // Element 0 has no layout box (unrendered) — the fake rejects fill()
    // with NODE_NOT_ACTIONABLE_MESSAGE the same way a real -32000 CDP error
    // would. Element 1 is rendered and should receive the fill instead.
    // findDeepLocatorCandidateByFieldLabel picks one match per attempt (no
    // in-attempt retry) — it's attempt 2 and 4's shared triedSelectors
    // exclusion that lets attempt 4 pick element 1 after attempt 2's element
    // 0 failed to verify.
    registerDeepLocatorHopElements(frame, scopedHopSelector, [
      { text: "First Name", visible: false },
      { text: "First Name", visible: true },
    ]);
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "First Name");
    const page = makeDeepLocatorPage(frame);

    const fillSpy = vi.spyOn(deepLocatorActuateModule, "fillDeepLocatorCandidate");
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      runStep(page, "Fill in the First Name field with 'Reginald'", attemptsByFailure)
    ).resolves.toBe("completed");

    expect(fillSpy).toHaveBeenCalledTimes(2);
    expect(fillSpy.mock.calls[0]?.[3]).toBe(0);
    expect(fillSpy.mock.calls[1]?.[3]).toBe(1);

    const hop = frame.get(scopedHopSelector);
    expect(hop?.elements[0]?.filledWith).toBeNull();
    expect(hop?.elements[1]?.filledWith).toBe("Reginald");

    fillSpy.mockRestore();
  });

  it("a plain click step (no fill/select verb) still routes to clickDeepLocatorCandidate unchanged", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHopElements(frame, scopedHopSelector, ["Manual Application"]);
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, "Manual Application");
    const page = makeDeepLocatorPage(frame);

    const fillSpy = vi.spyOn(deepLocatorActuateModule, "fillDeepLocatorCandidate");
    const selectSpy = vi.spyOn(deepLocatorActuateModule, "selectDeepLocatorCandidateOption");
    const clickSpy = vi.spyOn(deepLocatorCandidatesModule, "clickDeepLocatorCandidate");
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      runStep(page, "Click the Manual Application button", attemptsByFailure)
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(clickSpy).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      0,
      expect.objectContaining({ frameTarget: expect.anything() })
    );
    expect(fillSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();

    const attempts = attemptsByFailure[0] ?? [];
    const deepLocatorAttempt = attempts.find((a) => a.resolvedMethod === "click");
    expect(deepLocatorAttempt?.actResultSuccess).toBe(true);
    expect(frame.get(scopedHopSelector)?.clicks).toBe(1);

    fillSpy.mockRestore();
    selectSpy.mockRestore();
    clickSpy.mockRestore();
  });
});
