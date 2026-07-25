import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { type FrameTarget, mainFrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP = "Click the 'Manual Application' button";

/** Stagehand whose observe/act always report "nothing here" — drives every step to the probe-absent dump path. */
function fakeStagehand(): Stagehand {
  return {
    act: vi.fn().mockResolvedValue({ success: false, message: "no-op" } as ActResult),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
}

/** Minimal top-frame `Page`: `url`/`title` are distinct from the child frame's so the assertions can tell them apart. */
function fakePage(): Page {
  return {
    url: () => "https://careers.uchealth.org/jobs/123-nurse",
    title: vi.fn().mockResolvedValue("UCHealth Careers"),
    evaluate: vi.fn().mockResolvedValue("<body>top document</body>"),
    locator: vi.fn(),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/** Child-frame `FrameTarget` whose `url`/`evaluate` resolve against the resolved iframe, not the top page. */
function fakeChildFrameTarget(): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: "iframe#talemetry_apply_iframe",
    evaluate: vi.fn().mockResolvedValue("<body>child frame</body>"),
    locator: vi.fn(),
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("UCHealth Careers"),
  };
}

function baseParams(page: Page, stagehand: Stagehand, frameTarget?: FrameTarget) {
  return {
    stagehand,
    page,
    frameTarget,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 1,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
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
  };
}

describe("flow-runner/executeStepWithHealing — failure-dump frame scoping (probe-absent path)", () => {
  it("pairs the child frame's url with its body HTML for an in-iframe step, not the top page's url", async () => {
    const page = fakePage();
    const frameTarget = fakeChildFrameTarget();
    const onStepFailure = vi.fn().mockReturnValue("/tmp/dump.json");
    const params = { ...baseParams(page, fakeStagehand(), frameTarget), onStepFailure };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const dump = onStepFailure.mock.calls[0]?.[0];
    expect(dump.pageUrl).toBe("https://apply.talemetry.com/application/abc-123");
    expect(dump.bodyOuterHtml).toBe("<body>child frame</body>");
    // FrameTarget.title() for a child frame intentionally still reads the
    // top document (CDP Page.title has no distinct child-frame title) — url
    // is the discriminator, not title.
    expect(dump.pageTitle).toBe("UCHealth Careers");
  });

  it("produces today's exact payload for a main-frame run: page.url()/page.title() and page's own body HTML", async () => {
    const page = fakePage();
    const onStepFailure = vi.fn().mockReturnValue("/tmp/dump.json");
    const params = {
      ...baseParams(page, fakeStagehand(), mainFrameTarget(page)),
      onStepFailure,
    };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const dump = onStepFailure.mock.calls[0]?.[0];
    expect(dump.pageUrl).toBe("https://careers.uchealth.org/jobs/123-nurse");
    expect(dump.pageTitle).toBe("UCHealth Careers");
    expect(dump.bodyOuterHtml).toBe("<body>top document</body>");
  });
});
