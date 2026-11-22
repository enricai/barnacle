import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeDeepLocator } from "@/scraper/deep-locator-fake";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

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
 * matching the real `mainFrameTarget`'s contract — so `page.url()` flips
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
    // Empty registry (no hops registered) so deepLocator resolves 0
    // candidates by default — this suite's fixtures assert on today's
    // pre-deepLocator behavior, not the new frame-scoped fallback path.
    deepLocator: makeFakeDeepLocator(new Map()),
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

describe("flow-runner/runHealingFlow — per-step frameSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
    guardedObserve.mockResolvedValue([
      { selector: "input#mname", description: "middle name", method: "fill" },
    ]);
  });

  it("resolves a step's own frameSelector over the flow-level one, falling back per step", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    resolveFrameTarget.mockImplementation(async (_p: unknown, sel: string) =>
      makeChildFrameTarget(sel, () => urls.current)
    );
    wireVerifiedGuardedAct(urls);
    const page = fakeFlowPage(() => urls.current);

    await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [step({ frameSelector: "iframe#other" }), step()],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: "iframe#flow",
    });

    const selectors = resolveFrameTarget.mock.calls
      .map(([, sel]) => sel)
      .filter((s) => s === "iframe#other" || s === "iframe#flow");
    expect(selectors).toEqual(["iframe#other", "iframe#flow"]);
    const first = guardedObserve.mock.calls[0]?.at(-1) as FrameTarget;
    expect(first.frameSelector).toBe("iframe#other");
  });
});
