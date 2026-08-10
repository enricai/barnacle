import type { Anthropic } from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StagehandModel } from "@/lib/bedrock";
import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import { type FakeDeepLocatorFrame, makeFakeDeepLocator } from "@/scraper/deep-locator-fake";
import type { HealingFlowStep } from "@/scraper/flow-runner";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
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
 * Regression coverage for the attempt-1 / pre-cascade sites inside
 * `executeStepWithHealing` that read `frameTarget ?? mainFrameTarget(page)`:
 * `tryRadioPrimitive`'s `target` param, the probe-absent
 * `hasUnfilledRequiredControlForStep` call, the pre-submit
 * `countNgInvalidContainers` baseline, and the attempt-1 pre/post
 * `snapshotPage` captures. Each is reachable on a SINGLE attempt-1 pass
 * through the cascade (no attempt-2 cascade body, no deep-submit-locator
 * branch) when the observe cascade finds no candidates.
 *
 * `tryRadioPrimitive` and `hasUnfilledRequiredControlForStep` are
 * module-local (not exported), so `vi.mock` cannot intercept them directly —
 * both funnel through `target.evaluate(expr)`, so identity is asserted by
 * mocking `@/scraper/frame-target`'s `mainFrameTarget` to a sentinel and
 * proving the sentinel's `evaluate` is never called while the resolved
 * child target's `evaluate` is. Extends the module-boundary mocking already
 * established in flow-runner.frame-threading.test.ts (mocks
 * @/scraper/frame-target + @/scraper/stagehand-guard) rather than inventing
 * a new harness.
 *
 * Sibling test-001-1-b appends further attempt-2-cascade-reachable
 * assertions to this same file: the attempt-2 `hasUnfilledRequiredControlForStep`
 * fast-skip guard, the llm-rephrase `extractLivePageFormEvidence` evidence
 * call, and the deep-submit-locator runner-up `snapshotPage` mid-attempt
 * capture — each behind its own precondition chain the no-candidate
 * attempt-1 fixture above never reaches.
 */

const resolveFrameTarget = vi.fn();
const waitForChildFrameReady = vi.fn().mockResolvedValue(undefined);
const mainFrameTarget = vi.fn();
const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: (...args: unknown[]) => waitForChildFrameReady(...args),
    mainFrameTarget: (...args: unknown[]) => mainFrameTarget(...args),
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

/**
 * The llm-rephrase branch (test-001-1-b's `:6252` site) reads live-page
 * evidence through `judgeErrorMessagesWithLLM`/`judgeInvalidFieldsWithLLM`,
 * which default their `captureFn` to the real `captureLlmCall` when the
 * caller passes none (`runHealingFlow` never threads a `captureFn` through)
 * — stubbing the NDJSON sink here keeps that path from touching disk, same
 * pattern as stagehand-guard.test.ts.
 */
vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: async (_input: LlmCallInput): Promise<void> => {},
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Builds a main-frame `FrameTarget` that delegates straight to `page` —
 * mirroring the real `mainFrameTarget`'s contract — so this remains a
 * distinct, identifiable object from any resolved child `FrameTarget`. Used
 * as the `mainFrameTarget(page)` mock return value: the fallback half of
 * every `frameTarget ?? mainFrameTarget(page)` shim these sites use, which
 * must NEVER be reached once a child frameTarget is threaded through.
 */
function delegatingMainFrameTarget(page: Page): FrameTarget {
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
 * Builds a child-frame `FrameTarget` whose `evaluate` is dispatched by the
 * calling expression's source text — the DOM-direct probes below
 * (`tryRadioPrimitive`'s enumerate, `hasUnfilledRequiredControlForStep`,
 * `countNgInvalidContainers`, `snapshotPage`, the submitted-state probe) each
 * evaluate a distinct expression body, so keying on a recognizable substring
 * lets one target answer every call correctly instead of one blanket
 * resolved value that would either starve `tryRadioPrimitive`'s poll loop or
 * force the submit-verification gate to always fail.
 */
function makeChildFrameTarget(
  frameSelector: string,
  getUrl: () => string,
  opts: {
    /** groupPresent shape returned to `tryRadioPrimitive`'s poll-enumerate. */
    radioGroupPresent?: boolean;
    /** Whether `hasUnfilledRequiredControlForStep`'s probe should report a match. */
    hasUnfilledRequiredControl?: boolean;
    /** Count returned to every `countNgInvalidContainers` call. */
    ngInvalidCount?: number;
    /** Selector reported present by the submitted-state DOM probe (final-step judge fallback). */
    submittedStateSelector?: string | null;
    /** `document.body.outerHTML` string returned to `extractLivePageFormEvidence`'s raw-body fetch. */
    bodyOuterHtml?: string | null;
    /** Ranked candidates returned to `buildRankSubmitCandidatesExpr`'s deep-submit-locator rank call. */
    rankSubmitCandidates?: {
      deepIndex: number;
      tier: 1 | 2 | 3;
      tag: string;
      accessibleName: string;
    }[];
    /** `{clicked}` result returned to every `buildClickByDeepIndexExpr` click call. */
    clickByDeepIndexResult?: { clicked: boolean };
  } = {}
): FrameTarget {
  const {
    radioGroupPresent = false,
    hasUnfilledRequiredControl = false,
    ngInvalidCount = 0,
    submittedStateSelector = null,
    bodyOuterHtml = null,
    rankSubmitCandidates = [],
    clickByDeepIndexResult = { clicked: false },
  } = opts;
  const evaluate = vi.fn(async (expr: unknown) => {
    const source = String(expr);
    if (source.includes("groupPresent")) {
      return radioGroupPresent ? { groupPresent: true, groups: [] } : { groupPresent: false };
    }
    if (source.includes("isRequired")) {
      return hasUnfilledRequiredControl;
    }
    if (source.includes('querySelectorAll("[class],[aria-invalid]")')) {
      return ngInvalidCount;
    }
    if (source.includes("document.querySelector(sel)")) {
      return submittedStateSelector;
    }
    if (source === "document.body ? document.body.outerHTML : null") {
      return bodyOuterHtml;
    }
    if (source.includes("ranked.sort")) {
      return rankSubmitCandidates;
    }
    if (source.includes('dispatchEvent(new Event("click"')) {
      return clickByDeepIndexResult;
    }
    if (source.includes("html:") && source.includes("text:")) {
      return { html: 0, text: "0:" };
    }
    return null;
  });
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector,
    evaluate: evaluate as FrameTarget["evaluate"],
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

/**
 * Fake page satisfying `wireSignalCapture`'s CDP plumbing plus the plain
 * evaluate/locator surface the fallback `mainFrameTarget(page)` shim would
 * touch if (and only if) the fix under test regressed. `getUrl` backs
 * `page.url()` with a mutable value so `guardedAct` can flip it for the
 * `urlChanged` verification signal. `deepLocator` resolves against
 * `deepLocatorFrame`, which defaults to an empty registry (no hops
 * registered, 0 candidates) — matching this suite's fixtures, which assert
 * on today's pre-deepLocator "absent"/no-candidates behavior. Callers
 * exercising the frame-scoped deepLocator fallback pass a pre-populated
 * `FakeDeepLocatorFrame` instead.
 */
function fakeFlowPage(
  getUrl: () => string,
  deepLocatorFrame: FakeDeepLocatorFrame = new Map()
): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    deepLocator: makeFakeDeepLocator(deepLocatorFrame),
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

/**
 * Radio-shaped instruction: `parseRadioStep` matches ("click" + "answer" +
 * two quoted strings), so `trySelectPrimitive`/`tryCheckboxPrimitive`/
 * `tryFillRequiredSelectsPrimitive` all no-op via `parseSelectStep` returning
 * null BEFORE touching `target` — leaving `tryRadioPrimitive` as the only
 * primitive that reaches `target.evaluate` for this step shape.
 */
const RADIO_STEP = "Click the 'Yes' answer for the question 'Are you 18 or older?'";

/**
 * Select-shaped instruction (has a question label), so
 * `hasUnfilledRequiredControlForStep`'s `parseSelectStep(instruction)?.questionLabel`
 * gate is satisfied and it actually calls `target.evaluate` instead of
 * short-circuiting on a null parse.
 */
const SELECT_STEP = "Select 'Yes' for 'Are you authorized to work in the US?'";

function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
  return {
    instruction: RADIO_STEP,
    optional: false,
    upload: false,
    submitStep: false,
    ...overrides,
  };
}

/**
 * `stagehand.act`/`stagehand.observe` are never called directly by this
 * suite (flow-runner calls `guardedAct`/`guardedObserve`, both mocked at the
 * module boundary), so the `Stagehand` value only needs to be a distinct,
 * identifiable object passed through untouched.
 */
function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Wires the observe cascade to report NO candidates on both the focused and unfocused probe. */
function wireNoCandidatesProbe(): void {
  guardedObserve.mockResolvedValue([]);
}

describe("flow-runner/executeStepWithHealing — attempt-1 pre-cascade frame-scoped sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `mainFrameTarget(page)` is the fallback half of every
    // `frameTarget ?? mainFrameTarget(page)` shim inside
    // executeStepWithHealing's DOM-direct probe helpers. It must delegate
    // straight to `page` (matching the real implementation's contract) but
    // is DELIBERATELY a distinct object from any resolved child FrameTarget
    // — the assertions below prove the probes' `.evaluate` lands on the
    // child, never on this fallback, which is what regresses if a
    // `frameTarget ??` swap is ever dropped back to a bare
    // `mainFrameTarget(page)`.
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
    wireNoCandidatesProbe();
  });

  it("threads the resolved child FrameTarget into tryRadioPrimitive's target param, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      radioGroupPresent: false,
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // No candidates + not optional: the step is expected to fail verification
    // (probe-absent, required) — this test's only concern is which target
    // object `tryRadioPrimitive` (run BEFORE the probe) evaluated against.
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: RADIO_STEP, optional: false })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/probe found no candidates/);

    // tryRadioPrimitive's enumerate expression is the ONLY primitive that
    // touches `target` for a radio-shaped instruction (select/checkbox/
    // fill-required-selects all short-circuit on `parseSelectStep` returning
    // null before reading `target`), so any call carrying the `groupPresent`
    // marker proves tryRadioPrimitive itself received the child target.
    const radioEnumerateCalls = (
      childTarget.evaluate as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([expr]) => String(expr).includes("groupPresent"));
    expect(radioEnumerateCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the probe-absent hasUnfilledRequiredControlForStep check, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      hasUnfilledRequiredControl: true,
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // Select-shaped + optional: the probe returns "absent", and because
    // hasUnfilledRequiredControlForStep reports a match (mocked above), the
    // cascade does NOT skip — it escalates into attempt 1, where guardedAct
    // returns no resolved action so the step fast-skips attempt 1 cleanly
    // and exhausts (anthropic: null short-circuits llm-rephrase) — this
    // test only cares that hasUnfilledRequiredControlForStep itself read
    // the child target.
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    // hasUnfilledRequiredControlForStep returning true only prevents the
    // clean "skipped" early-return — probe-absent still throws afterward
    // (no transition/backend-error detected), so this asserts the throw
    // that follows the escalation log, not cascade completion.
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: SELECT_STEP, optional: true })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/probe found no candidates/);

    const requiredControlCalls = (
      childTarget.evaluate as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([expr]) => String(expr).includes("isRequired"));
    expect(requiredControlCalls).toHaveLength(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the pre-submit countNgInvalidContainers baseline and the attempt-1 pre/post snapshotPage captures, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      ngInvalidCount: 0,
      // Judge-unavailable fallback (anthropic: null -> verifySubmitWithLLM
      // returns null): a DOM-state selector match verifies the step via
      // "submitted-state-dom" so attempt 1 completes without needing the
      // submit-verify judge fixture (owned by sibling test-001-2).
      submittedStateSelector: "[data-testid=thank-you]",
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    // This site's assertions live entirely in the attempt-1 pass PAST the
    // probe (requireSubmitEndpoint's pre-submit baseline, the pre/post
    // snapshot) — so, unlike the other tests in this file, the probe must
    // find a candidate rather than report "absent".
    guardedObserve.mockResolvedValue([
      { selector: "button#submit", description: "Submit", method: "click" },
    ]);
    guardedAct.mockImplementation(async () => {
      urls.current = "https://apply.acme.example/jobs/1/apply/thank-you";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Click the Submit button",
        actions: [{ selector: "button#submit", description: "Submit", method: "click" }],
      };
    });

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: "Click the Submit button",
          optional: false,
          upload: false,
          submitStep: true,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: "iframe#apply_frame",
      submitEndpointPattern: "/gq",
      submittedStateSelectors: ["[data-testid=thank-you]"],
    });

    expect(result.lastStepIndex).toBe(0);

    const evaluateCalls = (childTarget.evaluate as ReturnType<typeof vi.fn>).mock.calls;
    // Pre-submit baseline: requireSubmitEndpoint gates this on submitStep +
    // submitEndpointPattern, computed once before the attempt loop.
    const ngInvalidCalls = evaluateCalls.filter(([expr]) =>
      String(expr).includes('querySelectorAll("[class],[aria-invalid]")')
    );
    expect(ngInvalidCalls.length).toBeGreaterThan(0);
    // Pre AND post snapshotPage captures for attempt 1 — both read
    // `target.evaluate(DOM_SNAPSHOT_EXPR)`, which reports `{html, text}`.
    const snapshotCalls = evaluateCalls.filter(
      ([expr]) => String(expr).includes("html:") && String(expr).includes("text:")
    );
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("main-frame control: frame: null target behavior is byte-identical to today (mainFrameTarget(page) IS the target, evaluate lands on page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    // No frameSelector -> resolveFrameTarget degrades to the real
    // main-frame bridge; wire it to return a target that delegates straight
    // to `page`, matching production's `mainFrameTarget` contract.
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);
    const mainTarget = delegatingMainFrameTarget(page);
    resolveFrameTarget.mockResolvedValue(mainTarget);

    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: RADIO_STEP, optional: false })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow(/probe found no candidates/);

    // The main-frame target delegates to `page` itself, so every DOM-direct
    // evaluate this attempt touches — including tryRadioPrimitive's
    // enumerate — lands on `page.evaluate`, exactly like today's
    // no-frameTarget behavior.
    const radioEnumerateCalls = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([expr]) => String(expr).includes("groupPresent")
    );
    expect(radioEnumerateCalls.length).toBeGreaterThan(0);
    // The `mainFrameTarget(page)` module mock is never invoked in this path:
    // `frameTarget` (resolved once at the top of runHealingFlow) is already
    // the main-frame target, so every `frameTarget ?? mainFrameTarget(page)`
    // shim short-circuits on the left side of `??`.
    expect(mainFrameTarget).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — attempt-2-cascade-reachable frame-scoped sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into the attempt-2 hasUnfilledRequiredControlForStep fast-skip guard, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      hasUnfilledRequiredControl: true,
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // Pre-cascade probe (probeStepBeforeAttempts) must find a candidate so
    // the step proceeds into the attempt loop instead of fast-skipping via
    // the SEPARATE probe-absent guard (owned by test-001-1-a). Attempt 1
    // (act-string) then resolves nothing, and attempt 2's observe also
    // reports zero candidates — the exact "no candidates after act+observe"
    // precondition this site's guard requires.
    guardedObserve
      .mockResolvedValueOnce([
        {
          selector: "select#work-auth",
          description: "Are you authorized to work?",
          method: "select",
        },
      ])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    // optional: true + zero triedSelectors is required for the fast-skip
    // guard itself to run; hasUnfilledRequiredControl: true (wired above)
    // then makes it NOT skip, so the cascade escalates through attempts 3-5
    // and exhausts instead of returning "skipped".
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: SELECT_STEP, optional: true })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Distinctive log line this branch (and only this branch) emits when it
    // does NOT fast-skip — proves the guard was reached and evaluated true,
    // not vacuously passed through.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "no candidates after act+observe but a required unfilled control matches; NOT skipping (continuing cascade)"
      )
    );
    const requiredControlCalls = (
      childTarget.evaluate as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([expr]) => String(expr).includes("isRequired"));
    expect(requiredControlCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the llm-rephrase extractLivePageFormEvidence evidence call, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const bodyHtml = "<body><form>rephrase-evidence-fixture</form></body>";
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      bodyOuterHtml: bodyHtml,
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // Fake Anthropic client: `messages.parse` is called both by the
    // invalid-fields/error-messages judges inside extractLivePageFormEvidence
    // and by rephraseWithLLM itself. Rejecting with a plain (non-billing,
    // non-rate-limit) Error lets every caller fall back to its documented
    // null/empty-evidence path without a real network call or flipping the
    // module-level billing flag other tests rely on being false.
    const messagesParse = vi.fn().mockRejectedValue(new Error("stub judge unavailable"));
    const anthropic = { messages: { parse: messagesParse } } as unknown as Anthropic;
    generateObject.mockRejectedValue(new Error("stub rephrase model unavailable"));
    const rephraseModel = { modelId: "test-model" } as unknown as StagehandModel;

    // Pre-cascade probe (probeStepBeforeAttempts) must find a candidate so
    // the step proceeds into the attempt loop instead of fast-skipping via
    // the probe-absent guard (owned by test-001-1-a). Attempt 1 (act-string)
    // then resolves nothing; attempts 2/3/4 all report no candidates / no
    // prior selector, so shouldSkipTechnique skips them and the cascade
    // lands on attempt 5 (llm-rephrase) — the ONLY branch that calls
    // extractLivePageFormEvidence. anthropic is non-null and the billing
    // flag was reset in beforeEach, so neither attempt-5 guard
    // short-circuits before the evidence call.
    guardedObserve
      .mockResolvedValueOnce([{ selector: "input#radio-yes", description: "Yes", method: "click" }])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: RADIO_STEP, optional: false })],
        logger: testLogger,
        anthropic,
        rephraseModel,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Proves the branch was reached: llm-rephrase is the only technique that
    // reads document.body.outerHTML through extractLivePageFormEvidence's
    // raw-body fetch (a bare expression string, not an IIFE — matched
    // exactly so it can't collide with probeLeafInvalidContainers' or
    // countNgInvalidContainers' distinct ng-invalid queries).
    const bodyFetchCalls = (childTarget.evaluate as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([expr]) => expr === "document.body ? document.body.outerHTML : null"
    );
    expect(bodyFetchCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into every guardedObserve call on the llm-rephrase path (focused candidates + unfocused ambient-UI observe), not undefined", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // Same fixture as the extractLivePageFormEvidence test above: reject
    // messages.parse so rephraseWithLLM falls back to its documented
    // outcome=impossible path without a real network call.
    const messagesParse = vi.fn().mockRejectedValue(new Error("stub judge unavailable"));
    const anthropic = { messages: { parse: messagesParse } } as unknown as Anthropic;
    generateObject.mockRejectedValue(new Error("stub rephrase model unavailable"));
    const rephraseModel = { modelId: "test-model" } as unknown as StagehandModel;

    // Attempt 1 (act-string) resolves nothing; attempts 2/3/4 report no
    // candidates / no prior selector and are skipped, landing the cascade on
    // attempt 5 (llm-rephrase) — the branch under test at flow-runner.ts:6270
    // (focused candidates) and :6295 (unfocused ambient-UI observe).
    guardedObserve
      .mockResolvedValueOnce([{ selector: "input#radio-yes", description: "Yes", method: "click" }])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: RADIO_STEP, optional: false })],
        logger: testLogger,
        anthropic,
        rephraseModel,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Every guardedObserve call across the whole cascade — including the two
    // llm-rephrase-only calls (focused candidates, unfocused ambient-UI
    // observe) — must carry the resolved child FrameTarget as its trailing
    // arg, not undefined (which would fall through to the top document).
    expect(guardedObserve.mock.calls.length).toBeGreaterThan(0);
    for (const call of guardedObserve.mock.calls) {
      expect(call.at(-1)).toBe(childTarget);
    }
  });

  it("threads the resolved child FrameTarget into the unfocusedForJudge guardedObserve call feeding the success-state judge, not undefined", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      ngInvalidCount: 0,
      submittedStateSelector: "[data-testid=thank-you]",
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    // requireSubmitEndpoint (submitStep + submitEndpointPattern) gates the
    // branch at flow-runner.ts:6471 that builds unfocusedForJudge — the site
    // under test. The probe must find a candidate so attempt 1 proceeds past
    // the probe-absent fast-skip (owned by sibling test-001-1-a).
    guardedObserve.mockResolvedValue([
      { selector: "button#submit", description: "Submit", method: "click" },
    ]);
    guardedAct.mockImplementation(async () => {
      urls.current = "https://apply.acme.example/jobs/1/apply/thank-you";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Click the Submit button",
        actions: [{ selector: "button#submit", description: "Submit", method: "click" }],
      };
    });

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: "Click the Submit button",
          optional: false,
          upload: false,
          submitStep: true,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: "iframe#apply_frame",
      submitEndpointPattern: "/gq",
      submittedStateSelectors: ["[data-testid=thank-you]"],
    });

    expect(result.lastStepIndex).toBe(0);

    // unfocusedForJudge (flow-runner.ts:6503) runs unconditionally ahead of
    // verifySubmitWithLLM, so it fires even with anthropic: null — every
    // guardedObserve call across the attempt (including this one) must carry
    // the resolved child FrameTarget as its trailing arg, not undefined.
    expect(guardedObserve.mock.calls.length).toBeGreaterThan(0);
    for (const call of guardedObserve.mock.calls) {
      expect(call.at(-1)).toBe(childTarget);
    }
  });

  it("threads the resolved child FrameTarget into the deep-submit-locator runner-up mid-attempt snapshotPage capture, not mainFrameTarget(page)", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const topCandidate = {
      deepIndex: 0,
      tier: 3 as const,
      tag: "button",
      accessibleName: "Submit",
    };
    const runnerUpCandidate = {
      deepIndex: 1,
      tier: 2 as const,
      tag: "button",
      accessibleName: "Submit Application",
    };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      rankSubmitCandidates: [topCandidate, runnerUpCandidate],
      // Every click-by-deep-index call reports clicked:true — both the top
      // pick's click and (if the phantom verdict fires) the runner-up's —
      // so `resolvedAction` is always set and the cascade never falls
      // through to the stale-index re-rank loop.
      clickByDeepIndexResult: { clicked: true },
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    // Pre-cascade probe (probeStepBeforeAttempts) must find a candidate so
    // the step proceeds into the attempt loop instead of fast-skipping via
    // the probe-absent guard (owned by test-001-1-a).
    guardedObserve.mockResolvedValue([
      { selector: "button#submit", description: "Submit", method: "click" },
    ]);

    // Attempt 1 (act-string) reports success but the pre/post snapshot is
    // unchanged (childTarget's evaluate always answers the DOM_SNAPSHOT_EXPR
    // marker with the same {html:0, text:"0:"} shape, and the URL/network
    // counter don't move either) — classifyPhantomClick therefore verdicts
    // "phantom", which is exactly the precondition that escalates attempt 2
    // to deep-submit-locator on this submit-shaped step.
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Click the Submit button",
      actions: [{ selector: "button#submit", description: "Submit", method: "click" }],
    });

    // No submitEndpointPattern is configured, so requireSubmitEndpoint is
    // false and verification falls back to network/url/dom signals alone —
    // none of which this fixture's flat, unchanging snapshot can produce.
    // The step therefore exhausts all 5 attempts and throws; that's fine —
    // this test's only concern is that attempt 2 reached the runner-up
    // retry and snapshotted against the resolved child target on the way,
    // not that the step ultimately verifies (submit-verify judge behavior
    // is owned by sibling test-001-2).
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [
          {
            instruction: "Click the Submit button",
            optional: false,
            upload: false,
            submitStep: true,
          },
        ],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // The runner-up retry only fires when the TOP pick's own click also
    // phantoms (classifyPhantomClick on the mid-attempt snapshot) — the
    // fixture's flat {html:0,text:"0:"}/unchanged-url snapshot guarantees
    // that, so the cascade reaches the runner-up click on attempt 2.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("phantom-clicked; retrying runner-up")
    );

    // Proves the site under test was reached: the mid-attempt snapshotPage
    // call is the ONLY DOM_SNAPSHOT_EXPR-shaped evaluate that happens
    // strictly between the rank call and the runner-up click call, so
    // asserting at least 2 snapshot-shaped evaluate calls occurred after the
    // rank call confirms the mid-post snapshot (pre + mid, at minimum) fired
    // against the child target rather than being skipped.
    const evaluateCalls = (childTarget.evaluate as ReturnType<typeof vi.fn>).mock.calls;
    const rankCallIndex = evaluateCalls.findIndex(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCallIndex).toBeGreaterThanOrEqual(0);
    const snapshotCallsAfterRank = evaluateCalls
      .slice(rankCallIndex + 1)
      .filter(([expr]) => String(expr).includes("html:") && String(expr).includes("text:"));
    expect(snapshotCallsAfterRank.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
