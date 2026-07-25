import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for `runHealingFlow`'s per-step-resolve-and-thread seam:
 * `deps.frameSelector` must reach `resolveFrameTarget` fresh for every step
 * (so an iframe created mid-flow is picked up as soon as it attaches), and
 * whatever `FrameTarget` a given step resolves must be the SAME object
 * threaded into every guarded Stagehand call for that step — not silently
 * discarded (the gap this file exists to catch: `frameTarget` appeared 0
 * times in flow-runner.ts even though the `frameSelector` dep field was
 * already accepted).
 *
 * Mocks `@/scraper/frame-target` and `@/scraper/stagehand-guard` at the
 * module boundary (rather than faking a `Page`/`Frame` shape) so the
 * assertions are about THREADING — which object crosses which call boundary
 * — not about `resolveFrameTarget`'s own origin-matching logic (covered by
 * `frame-resolve.test.ts`) or `probeStepBeforeAttempts`'s hop-selector
 * scoping (covered by `recon-browser.test.ts`).
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
 * mirroring the real `mainFrameTarget`'s contract — so `page.url()` flips
 * (the `urlChanged` verification signal) are visible through it exactly
 * like they would be through the unmocked implementation.
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
 * `getUrl` backs `url()` with the SAME mutable value `wireVerifiedGuardedAct`
 * flips per step — required now that snapshotPage/countNgInvalidContainers
 * read `frameTarget.url()` instead of `page.url()` for an in-iframe step
 * (the fix under test): a static URL here would make `pre.url === post.url`
 * always, so the cascade's `urlChanged` verification signal could never
 * fire and every step would spuriously exhaust its attempts.
 */
function makeChildFrameTarget(frameSelector: string, getUrl: () => string): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector,
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn(),
    url: () => Promise.resolve(getUrl()),
    title: () => Promise.resolve("Apply"),
  };
}

/**
 * Fake page satisfying `wireSignalCapture`'s CDP plumbing plus the plain
 * evaluate surface `tryUploadPrimitive`'s no-op path touches. `getUrl` backs
 * `page.url()` with a mutable value so a step's `guardedAct` can flip it —
 * the `urlChanged` signal `executeStepWithHealing` uses to verify a step
 * without needing to script DOM-evaluate responses (irrelevant to this
 * suite's threading assertions).
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

/** Non-submit-shaped, non-select/checkbox/radio instruction — takes the attempt-1 `guardedAct(step, ...)` path. */
const STEP_A = "Fill in the middle name field";

/** Matches `parseSelectStep`, so `hasUnfilledRequiredControlForStep`'s probe-absent escalation check evaluates its target instead of short-circuiting on an unparsed instruction. */
const SELECT_STEP = "Select 'Yes' for 'Are you legally authorized to work?'";

function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
  return { instruction: STEP_A, optional: false, upload: false, submitStep: false, ...overrides };
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

/**
 * Wires `guardedAct` to report success and advance `urls.current` to a
 * fresh URL per call, so each step's post-attempt snapshot sees a URL delta
 * (`urlChanged`) and `executeStepWithHealing` verifies attempt 1 without
 * grinding the rest of the cascade.
 */
function wireVerifiedGuardedAct(urls: { current: string }): void {
  let stepCount = 0;
  guardedAct.mockImplementation(async () => {
    stepCount += 1;
    urls.current = `https://apply.acme.example/jobs/1/apply/step-${stepCount}`;
    return {
      success: true,
      message: "filled",
      actionDescription: "Fill in the middle name field",
      actions: [{ selector: "input#mname", description: "middle name", method: "fill" }],
    };
  });
}

describe("flow-runner/runHealingFlow — frameSelector -> FrameTarget threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `mainFrameTarget(page)` is the fallback half of every
    // `frameTarget ?? mainFrameTarget(page)` shim inside
    // executeStepWithHealing's DOM-direct probe helpers (snapshotPage,
    // countNgInvalidContainers, hasUnfilledRequiredControlForStep, ...). It
    // must delegate straight to `page` (matching the real implementation's
    // contract) so URL-flip verification still works, but it is
    // DELIBERATELY a distinct object from any resolved child FrameTarget —
    // the sentinel-object tests below assert the probes' `.evaluate` lands
    // on the child, never on this fallback, which is what regresses if a
    // `frameTarget ??` swap is ever dropped back to a bare
    // `mainFrameTarget(page)`.
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
    guardedObserve.mockResolvedValue([
      { selector: "input#mname", description: "middle name", method: "fill" },
    ]);
  });

  it("re-resolves frameSelector into a FrameTarget once per step and threads the resolved object into guardedObserve for that step", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);

    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step(), step()],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
    });

    // The flow-level frameSelector is re-resolved once PER STEP — not cached
    // across the run — so an iframe that attaches mid-flow is picked up as
    // soon as it's reachable. (Other internal call sites separately call
    // `resolveFrameTarget(page)` with no selector as a main-frame bridge;
    // that's a distinct, pre-existing pattern this assertion does not
    // concern itself with.)
    const topLevelResolveCalls = resolveFrameTarget.mock.calls.filter(
      ([, selector]) => selector === "iframe#talemetry_apply_iframe"
    );
    expect(topLevelResolveCalls).toHaveLength(2);
    for (const call of topLevelResolveCalls) {
      expect(call).toEqual([page, "iframe#talemetry_apply_iframe"]);
    }

    // Every guardedObserve call across both steps carries the resolved
    // FrameTarget instance as its trailing arg — proving it was threaded
    // through executeStepWithHealing rather than dropped.
    expect(guardedObserve.mock.calls.length).toBeGreaterThan(0);
    for (const call of guardedObserve.mock.calls) {
      expect(call.at(-1)).toBe(childTarget);
    }
  });

  it("resolves step 1 to the main frame and step 2+ to the child frame once it attaches mid-flow", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);
    const mainTarget = delegatingMainFrameTarget(page);
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);

    // Models an iframe created mid-flow: `page.frames()` (proxied here via
    // `resolveFrameTarget`'s own contract) has no match on the first call and
    // the matching child frame from the second call onward — proving
    // `runHealingFlow` re-resolves per step rather than freezing whatever the
    // FIRST resolve returned.
    resolveFrameTarget.mockResolvedValueOnce(mainTarget).mockResolvedValue(childTarget);

    wireVerifiedGuardedAct(urls);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step(), step()],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
    });

    expect(guardedObserve.mock.calls).toHaveLength(2);
    const [firstStepObserveCall, secondStepObserveCall] = guardedObserve.mock.calls as [
      unknown[],
      unknown[],
    ];
    const firstStepTarget = firstStepObserveCall.at(-1) as FrameTarget;
    const secondStepTarget = secondStepObserveCall.at(-1) as FrameTarget;
    expect(firstStepTarget).toBe(mainTarget);
    expect(firstStepTarget.frame).toBeNull();
    expect(secondStepTarget).toBe(childTarget);
    expect(secondStepTarget.frame).not.toBeNull();
  });

  it("waits for the resolved child frame to be ready before stepping", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);

    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step()],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
    });

    expect(waitForChildFrameReady).toHaveBeenCalledTimes(1);
    expect(waitForChildFrameReady).toHaveBeenCalledWith(childTarget);
  });

  it("still resolves via resolveFrameTarget when frameSelector is omitted, and threads the resulting (main-frame) target identically", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);
    const mainTarget = delegatingMainFrameTarget(page);
    resolveFrameTarget.mockResolvedValue(mainTarget);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step()],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
    });

    // The flow-level call (2 args: page + deps.frameSelector, explicitly
    // `undefined` here) is runHealingFlow's own top-level resolve — distinct
    // from the internal `resolveFrameTarget(page)` (1-arg) main-frame-bridge
    // calls elsewhere in the cascade.
    const topLevelResolveCalls = resolveFrameTarget.mock.calls.filter((args) => args.length === 2);
    expect(topLevelResolveCalls).toHaveLength(1);
    expect(topLevelResolveCalls[0]).toEqual([page, undefined]);

    for (const call of guardedObserve.mock.calls) {
      expect(call.at(-1)).toBe(mainTarget);
    }
  });

  it("threads the resolved child FrameTarget into the DOM-direct probe helpers (snapshotPage, countNgInvalidContainers), not the mainFrameTarget(page) shim", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);

    // A submit-shaped step also exercises the `requireSubmitEndpoint`-gated
    // `countNgInvalidContainers` calls (pre- and post-attempt), in addition
    // to the unconditional `snapshotPage` pre/post calls every step takes.
    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step({ submitStep: true })],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
    });

    // snapshotPage/countNgInvalidContainers call target.evaluate(...) — proof
    // they ran against the resolved child frame, not the mainFrameTarget(page)
    // fallback, is that the child's `evaluate` mock (not the fallback's
    // `page.evaluate`) was invoked.
    expect(childTarget.evaluate).toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the probe-absent required-control escalation check, not the mainFrameTarget(page) shim", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);
    // An empty observe makes probeStepBeforeAttempts report "absent", which
    // — for an `optional` step — routes into
    // `hasUnfilledRequiredControlForStep(frameTarget ?? mainFrameTarget(page), step)`
    // instead of the attempt cascade this suite's other cases exercise.
    guardedObserve.mockResolvedValue([]);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    await runHealingFlow({
      stagehand,
      page,
      steps: [step({ instruction: SELECT_STEP, optional: true })],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: "iframe#talemetry_apply_iframe",
    });

    expect(childTarget.evaluate).toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the pre-submit ng-invalid count, not the mainFrameTarget(page) shim", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#talemetry_apply_iframe", () => urls.current);
    resolveFrameTarget.mockResolvedValue(childTarget);

    // `submitEndpointPattern` set on a `submitStep` arms `requireSubmitEndpoint`,
    // which gates the unconditional pre-attempt
    // `countNgInvalidContainers(frameTarget ?? mainFrameTarget(page))` call —
    // a distinct call site from the unconditional pre/post `snapshotPage`
    // calls the DOM-direct-probe-helpers case above already covers. With no
    // `anthropic` client and no `submittedStateSelectors` match, the final
    // submit-verification judge can't confirm the step (real,
    // unmocked-judge behavior) — irrelevant here since the pre-submit probe
    // runs unconditionally, before the attempt loop even starts.
    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ submitStep: true })],
        logger: testLogger,
        anthropic: null,
        resumeFixture: null,
        frameSelector: "iframe#talemetry_apply_iframe",
        submitEndpointPattern: "apply\\.talemetry\\.com",
      })
    ).rejects.toThrow();

    expect(childTarget.evaluate).toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("degrades to the main-frame target without throwing when frameSelector cannot be resolved", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    wireVerifiedGuardedAct(urls);
    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);
    // resolveFrameTarget's own contract (proven in frame-resolve.test.ts) is
    // to fall back to a main-frame target rather than throw on an
    // unresolvable selector — this test proves runHealingFlow relies on
    // that contract instead of adding its own try/catch around resolution.
    const mainTarget = delegatingMainFrameTarget(page);
    resolveFrameTarget.mockResolvedValue(mainTarget);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step()],
        logger: testLogger,
        anthropic: null,
        resumeFixture: null,
        frameSelector: "iframe#stale-selector-not-on-page",
      })
    ).resolves.toMatchObject({ lastStepIndex: 0 });

    expect(resolveFrameTarget).toHaveBeenCalledWith(page, "iframe#stale-selector-not-on-page");
    for (const call of guardedObserve.mock.calls) {
      expect(call.at(-1)).toBe(mainTarget);
    }
  });
});
