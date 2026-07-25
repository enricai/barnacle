import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

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
 * assertions to this same file.
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
  } = {}
): FrameTarget {
  const {
    radioGroupPresent = false,
    hasUnfilledRequiredControl = false,
    ngInvalidCount = 0,
    submittedStateSelector = null,
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
 * `urlChanged` verification signal.
 */
function fakeFlowPage(getUrl: () => string): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
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
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current, {
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
        resumeFixture: null,
        frameSelector: "iframe#talemetry_apply_iframe",
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
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current, {
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
        resumeFixture: null,
        frameSelector: "iframe#talemetry_apply_iframe",
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
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current, {
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
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
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
        resumeFixture: null,
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
