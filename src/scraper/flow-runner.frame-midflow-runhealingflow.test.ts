import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for `runHealingFlow`'s library entrypoint (distinct from
 * the recon CLI, which already re-resolves per step) driving a mid-flow
 * iframe: `deps.frameSelector` must be resolved via the REAL
 * `resolveFrameTarget`/`waitForChildFrameReady` fresh for every step, not once
 * before the step loop, so an `<iframe>` a step-1 side effect creates is
 * entered by step 2. Unlike `flow-runner.frame-threading.test.ts`, this file
 * does NOT mock `@/scraper/frame-target` — the fake `Page`'s `frames()` /
 * queryable element map are mutated by step 1's `guardedAct` (mocked at the
 * `@/scraper/stagehand-guard` boundary only), so resolution itself, not just
 * threading, is exercised end to end.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

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

const FRAME_SELECTOR = "#apply_frame";
const CHILD_ORIGIN_URL = "https://apply.example.com/application/abc-123";

/**
 * Fake cross-origin `Frame`: answers `location.href` with the SAME mutable
 * value the step's `guardedAct` flips per call, so `snapshotPage`'s
 * pre/post `frameTarget.url()` reads see a delta and the cascade's
 * `urlChanged` signal fires — otherwise a static url would make every
 * attempt look unverified and step 2 would exhaust its cascade instead of
 * proving the frame was entered.
 */
function makeFakeFrame(getUrl: () => string) {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return getUrl();
      if (expr === "document.readyState") return "complete";
      return null;
    },
    locator: (selector: string) => ({ scope: "frame" as const, selector }),
  };
}

/**
 * Fake `Page` whose iframe element and `frames()` list start EMPTY (no
 * `<iframe>` present at flow start, per the subtask's reproduction) and are
 * populated only once `attach()` is called — modeling the "Apply now" click
 * creating the mid-flow `<iframe>`. `getChildUrl` is a SEPARATE mutable value
 * from the top page's own url (real cross-origin frames navigate
 * independently), so the child frame's `urlChanged` signal can fire for step
 * 2 even though it never touches the top document's url.
 */
function makeMidFlowFakePage(
  getTopUrl: () => string,
  getChildUrl: () => string
): { page: Page; attach: () => void } {
  let attached = false;
  const childFrame = makeFakeFrame(getChildUrl);
  const session = { on: () => {}, off: () => {} };

  const page = {
    url: getTopUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    evaluate: vi.fn(async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (selector !== FRAME_SELECTOR || !attached) return { matched: false, src: null };
      return { matched: true, src: CHILD_ORIGIN_URL };
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: () => (attached ? [childFrame] : []),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  return {
    page,
    attach: () => {
      attached = true;
    },
  };
}

function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
  return {
    instruction: "Fill in the middle name field",
    optional: false,
    upload: false,
    submitStep: false,
    ...overrides,
  };
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

describe("flow-runner/runHealingFlow — resolves a mid-flow iframe per step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "input#mname", description: "middle name", method: "fill" },
    ]);
  });

  it("re-resolves per step so step 2 enters an iframe that only appears after step 1's side effect runs", async () => {
    const topUrls = { current: "https://careers.example.org/jobs/123" };
    const childUrls = { current: CHILD_ORIGIN_URL };
    const { page, attach } = makeMidFlowFakePage(
      () => topUrls.current,
      () => childUrls.current
    );
    const stagehand = makeStagehand();

    let stepCount = 0;
    guardedAct.mockImplementation(async () => {
      stepCount += 1;
      // Step 1 ("Apply now") is what creates the <iframe> — mirrors the
      // the top-window site repro where the wizard mounts only after this click.
      if (stepCount === 1) {
        attach();
        topUrls.current = "https://careers.example.org/jobs/123/apply";
      } else {
        childUrls.current = `${CHILD_ORIGIN_URL}?step=${stepCount}`;
      }
      return {
        success: true,
        message: "acted",
        actionDescription: "clicked",
        actions: [{ selector: "input#mname", description: "middle name", method: "fill" }],
      };
    });

    await runHealingFlow({
      stagehand,
      page,
      steps: [step({ instruction: "Apply now" }), step({ instruction: "Manual Application" })],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(guardedObserve.mock.calls).toHaveLength(2);
    const [firstStepCall, secondStepCall] = guardedObserve.mock.calls as [unknown[], unknown[]];
    const firstStepTarget = firstStepCall.at(-1) as {
      frame: unknown;
      frameSelector: string | null;
    };
    const secondStepTarget = secondStepCall.at(-1) as {
      frame: unknown;
      frameSelector: string | null;
    };

    // Step 1 runs before the iframe exists — resolves to the main frame.
    expect(firstStepTarget.frame).toBeNull();
    expect(firstStepTarget.frameSelector).toBeNull();

    // Step 2 runs after step 1's side effect attaches the iframe — resolves
    // to the child frame, proving runHealingFlow re-resolved rather than
    // reusing the frame target captured before the loop started.
    expect(secondStepTarget.frame).not.toBeNull();
    expect(secondStepTarget.frameSelector).toBe(FRAME_SELECTOR);
  });
});
