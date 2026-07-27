import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Small override of the real `config.scraper.*` frame timeouts so the
 * step-entry `resolveFrameTarget` poll (which is EXPECTED to fail in the
 * scenario below — the OOPIF hasn't attached yet) gives up quickly instead
 * of burning the production 20s default. Everything else in `@/config`
 * stays the real loaded config (via `importOriginal`), so this file doesn't
 * have to stub out fields unrelated to frame timing.
 */
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      scraper: {
        ...actual.config.scraper,
        frameReadyTimeoutMs: 30,
        frameDocumentReadyTimeoutMs: 20,
      },
    },
  };
});

import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHop,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import * as frameTargetModule from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance test for the trigger half of the bug report: a step
 * that loses the frame-attach race at step entry (`resolveFrameTarget`
 * falls back to the main frame, pinning `frameTarget.frame` to `null`) must
 * still reach the in-frame control once the OOPIF attaches later in the
 * cascade — the run 6 shape, where the frame lost the race and the step
 * never got another chance to look for it. Drives the REAL `runHealingFlow`
 * / `resolveFrameTarget` / `guardedObserve`/`guardedAct` stack — only
 * Stagehand and Playwright's `Page`/`Frame` are faked — same model as
 * `flow-runner.oopif-candidate-ranking.test.ts`, chosen over the
 * `vi.mock`-based `flow-runner.deep-locator-*.test.ts` files because the
 * seam under test IS `resolveFrameTarget` re-running mid-step, which those
 * files mock away entirely.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's attempt-2/4 branch resolves candidates at the interactive-scoped hop (bugfix-005), not `"*"`; the probe never reaches deepLocator in this suite (see `makeFakeStagehandAttachingOnAct`'s unfocused-observe short-circuit). */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const MANUAL_APPLICATION_STEP = "Click the 'Manual Application' button.";

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function makeFakeChildFrame(childUrls: { current: string }) {
  return {
    evaluate: async (expr: unknown) =>
      expr === "location.href" ? childUrls.current : { html: 0, text: "0:" },
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
  };
}

/**
 * Fake `Stagehand` whose `observe()` is empty for every FOCUSED call
 * (matching a step instruction) — forcing the cascade past attempt 1 (act)
 * and into attempt 2's `observe-act` branch, the one that owns the
 * deepLocator-direct gate under test — but returns a harmless non-empty
 * result for the UNFOCUSED call (no instruction) so `probeStepBeforeAttempts`
 * declares the step "present" via its own unfocused-observe fallback,
 * WITHOUT ever touching `frameTarget.frame` itself. That keeps the probe out
 * of this test's way entirely: the one re-resolution attempt under test
 * fires at attempt 2's gate, not the probe's.
 *
 * `act` always fails (attempt 1 never resolves anything) and, as a side
 * effect, calls `attach()` — modeling the OOPIF attaching sometime during
 * the cascade's processing of attempt 1, AFTER the step-entry
 * `resolveFrameTarget` already gave up and fell back to the main frame.
 */
function makeFakeStagehandAttachingOnAct(attach: () => void) {
  return {
    act: async () => {
      attach();
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: "",
        actions: [],
      };
    },
    observe: async (instructionOrOptions?: unknown) =>
      typeof instructionOrOptions === "string"
        ? []
        : [{ selector: "body", description: "page body", method: "click" }],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * Fake two-frame `Page` whose `frames()` starts EMPTY (no OOPIF at step
 * entry — forces `resolveFrameTarget`'s step-entry poll to exhaust and fall
 * back to the main frame) and only exposes the child frame once `attach()`
 * runs.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
): { page: import("@browserbasehq/stagehand").Page; attach: () => void } {
  let attached = false;
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      click: async () => {
        await delegate.click();
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
      },
      nth: (index: number) => {
        const inner = fakeDeepLocator(selector);
        const nthDelegate = inner.nth(index);
        return {
          ...nthDelegate,
          click: async () => {
            await nthDelegate.click();
            childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
          },
        };
      },
    };
  };
  const page = {
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
    title: async () => "UCHealth Careers",
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
    frames: () => (attached ? [childFrame] : []),
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;

  return {
    page,
    attach: () => {
      attached = true;
    },
  };
}

describe("flow-runner frame re-resolution before the deepLocator gate", () => {
  it("re-resolves a lost OOPIF and clicks 'Manual Application' through it, despite the frame being absent at step entry", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHop(deepLocatorFrame, HOP_SELECTOR, "Manual Application");
    const { page, attach } = makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);
    const stagehand = makeFakeStagehandAttachingOnAct(attach);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
      ],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    const hop = deepLocatorFrame.get(HOP_SELECTOR);
    expect(hop?.clicks).toBeGreaterThan(0);
  });
});

describe("flow-runner frame re-resolution — no declared frameSelector is a no-op", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("performs zero extra resolveFrameTarget calls for a flow that never declares a frameSelector", async () => {
    const resolveFrameTargetSpy = vi.spyOn(frameTargetModule, "resolveFrameTarget");
    const topUrl = { current: "https://jobs.example.com/apply" };
    const session = { on: () => {}, off: () => {} };
    const page = {
      evaluate: async () => null,
      url: () => topUrl.current,
      title: async () => "Apply",
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

    const stagehand = {
      act: async () => {
        topUrl.current = "https://jobs.example.com/apply/step-2";
        return {
          success: true,
          message: "acted",
          actionDescription: "clicked Apply",
          actions: [{ selector: "button#apply", description: "Apply", method: "click" }],
        };
      },
      observe: async () => [{ selector: "button#apply", description: "Apply", method: "click" }],
    } as unknown as import("@browserbasehq/stagehand").Stagehand;

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: "Click Apply", optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
    // The ONE call is `runHealingFlow`'s own per-step resolution (a no-op
    // main-frame target since `frameSelector` was never declared); the
    // deepLocator-gate re-resolution added in this fix must never fire a
    // second call when there's no declared frame to lose a race for.
    expect(resolveFrameTargetSpy).toHaveBeenCalledTimes(1);
  });
});
