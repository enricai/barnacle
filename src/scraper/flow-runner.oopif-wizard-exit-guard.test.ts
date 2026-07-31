import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act branch (attempt 2/4) refuses a wizard-exit candidate before
 * clicking it (`isWizardExitAction`), but the deepLocator fallback added
 * alongside it (#95) clicked its top-ranked candidate unconditionally — on a
 * cross-origin OOPIF where relevance ranking puts a "Save & Exit"/"Cancel"
 * control first, that fires exactly the destructive click the observe path
 * refuses. This suite pins the deepLocator branch to the same deny-list,
 * mocking `deep-locator-candidates.ts` directly so `clickDeepLocatorCandidate`
 * itself can be asserted never-called for the refused candidate.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();
const resolveDeepLocatorCandidates = vi.fn();
const clickDeepLocatorCandidate = vi.fn();

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

vi.mock("@/scraper/deep-locator-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/deep-locator-candidates")>();
  return {
    ...actual,
    resolveDeepLocatorCandidates: (...args: unknown[]) => resolveDeepLocatorCandidates(...args),
    clickDeepLocatorCandidate: (...args: unknown[]) => clickDeepLocatorCandidate(...args),
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

/** Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}` probe so pre/post captures don't throw, and whose `url()` tracks a mutable ref so a click's URL advance gives the cascade's `urlChanged` verification signal a genuine reason to fire. */
function makeChildFrameTarget(urls: { current: string }): FrameTarget {
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
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(urls: { current: string }): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    deepLocator: vi.fn(),
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
}

describe("flow-runner/executeStepWithHealing — deepLocator branch honors the wizard-exit deny-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("refuses the top-ranked deepLocator candidate when its accessible text matches a wizard-exit label", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const wizardExitCandidate: DeepLocatorCandidate = {
      index: 0,
      selector: `deeplocator=iframe#talemetry_apply_iframe >> ${INTERACTIVE_CANDIDATE_SELECTOR} >> nth=0`,
      accessibleText: "Save & Exit",
    };
    // Ranked first, mirroring the bug report's scenario where relevance
    // ranking (not DOM order) puts the destructive control on top.
    resolveDeepLocatorCandidates.mockResolvedValue([wizardExitCandidate]);

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: [
          {
            instruction: "Click 'Save & Exit' to proceed",
            optional: false,
            upload: false,
            submitStep: false,
          },
        ],
        logger: testLogger,
        anthropic: null,
        resumeFixture: null,
        frameSelector: FRAME_SELECTOR,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    expect(clickDeepLocatorCandidate).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/refused wizard-exit control: "Save & Exit"/)
    );
  });

  it("pushes the refused candidate's selector to triedSelectors so attempt 4's exclusion surfaces the benign runner-up instead", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    const childFrameTarget = makeChildFrameTarget(urls);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const wizardExitCandidate: DeepLocatorCandidate = {
      index: 0,
      selector: `deeplocator=iframe#talemetry_apply_iframe >> ${INTERACTIVE_CANDIDATE_SELECTOR} >> nth=0`,
      accessibleText: "Save & Exit",
    };
    const benignCandidate: DeepLocatorCandidate = {
      index: 1,
      selector: `deeplocator=iframe#talemetry_apply_iframe >> ${INTERACTIVE_CANDIDATE_SELECTOR} >> nth=1`,
      accessibleText: "Manual Application",
    };
    // The real resolveDeepLocatorCandidates ranks the destructive control
    // first; flow-runner.ts is responsible for filtering its own
    // triedSelectors client-side (there's no server-side ignoreSelectors
    // equivalent for deepLocator), so the mock always returns both — the
    // exclusion under test happens in flow-runner.ts's own `.filter(...)`
    // call, not in this mock.
    resolveDeepLocatorCandidates.mockImplementation(async () => [
      wizardExitCandidate,
      benignCandidate,
    ]);
    clickDeepLocatorCandidate.mockImplementation(async (_page, _frameSelector, _inner, index) => {
      if (index === benignCandidate.index) {
        urls.current = "https://apply.acme.example/jobs/1/apply/manual";
      }
    });

    const result = await runHealingFlow({
      stagehand: makeStagehand(),
      page,
      steps: [
        {
          instruction: "Click 'Save & Exit' or 'Manual Application' to proceed",
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
    // Attempt 2 refused wizardExitCandidate without clicking it; the only
    // click that ever landed was on the benign runner-up once the exclusion
    // filter (fed by triedSelectors) surfaced it on a later attempt.
    expect(clickDeepLocatorCandidate).not.toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      wizardExitCandidate.index
    );
    expect(clickDeepLocatorCandidate).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      benignCandidate.index,
      { frameTarget: childFrameTarget }
    );
  });

  it("control case: clicks the top-ranked deepLocator candidate when its accessible text is benign", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const page = makeFakePage(urls);
    const childFrameTarget = makeChildFrameTarget(urls);
    resolveFrameTarget.mockResolvedValue(childFrameTarget);
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    const benignCandidate: DeepLocatorCandidate = {
      index: 0,
      selector: `deeplocator=iframe#talemetry_apply_iframe >> ${INTERACTIVE_CANDIDATE_SELECTOR} >> nth=0`,
      accessibleText: "Manual Application",
    };
    resolveDeepLocatorCandidates.mockResolvedValue([benignCandidate]);
    clickDeepLocatorCandidate.mockImplementation(async () => {
      urls.current = "https://apply.acme.example/jobs/1/apply/manual";
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
      resumeFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(clickDeepLocatorCandidate).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      INTERACTIVE_CANDIDATE_SELECTOR,
      benignCandidate.index,
      { frameTarget: childFrameTarget }
    );
  });
});
