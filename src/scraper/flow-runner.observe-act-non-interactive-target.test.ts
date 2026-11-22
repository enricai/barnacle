import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act branch must vet candidates for a step that declares a
 * non-interactive target before acting: a control is never clicked, and the
 * first non-control candidate is used instead.
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

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#apply_frame";

function makeChildFrameTarget(urls: { current: string }): FrameTarget {
  let snapshotCount = 0;
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const centred = answerCentreHitTest(expr);
      if (centred) return centred;
      // Return different values pre/post to trigger verification success
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue("Alice"),
      }),
    }),
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(urls: { current: string }): Page {
  let snapshotCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const centred = answerCentreHitTest(expr);
      if (centred) return centred;
      snapshotCount++;
      return { html: snapshotCount, text: `${snapshotCount}:value-${snapshotCount}` };
    }),
    deepLocator: vi.fn(),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue("Alice"),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

const STEP = "Click on a blank area of the page to dismiss any open dropdown";
const FAIL = { success: false, message: "no candidates", actionDescription: "", actions: [] };
const REFUSAL = "contradicts the step's non-interactive target";

async function runStep(urls: { current: string }): Promise<void> {
  await runHealingFlow({
    stagehand: makeStagehand(),
    page: makeFakePage(urls),
    steps: [{ instruction: STEP, optional: false, upload: false, submitStep: false }],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    frameSelector: FRAME_SELECTOR,
  }).catch(() => undefined);
}

function lines(): string[] {
  return (testLogger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
    String(c[0])
  );
}

function targetCalls(): unknown[][] {
  return guardedAct.mock.calls.filter(
    (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
  );
}

function cand(id: string, description: string) {
  return { selector: `xpath=//*[@id='${id}']`, description, method: "click", arguments: [] };
}

describe("flow-runner — observe-act vets candidates for non-interactive-target steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("refuses when every candidate is a control and never clicks", async () => {
    const urls = { current: "https://apply.acme.example/a" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([cand("m", "settings menu button")]);
    guardedAct.mockResolvedValue(FAIL);

    await runStep(urls);

    expect(targetCalls()).toHaveLength(0);
    expect(lines().some((l) => l.includes("attempt 2:") && l.includes(REFUSAL))).toBe(true);
  });

  it("acts on the first non-control candidate, skipping a control ahead of it", async () => {
    const urls = { current: "https://apply.acme.example/a" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([
      cand("m", "settings menu button"),
      cand("h", "page heading"),
    ]);
    guardedAct.mockImplementation(async (_s: unknown, i: unknown) => {
      if (typeof i === "string") return FAIL;
      urls.current = `${urls.current}/done`;
      return { success: true, message: "ok", actionDescription: "done", actions: [i] };
    });

    await runStep(urls);

    const first = targetCalls().at(0)?.[1] as { description?: string } | undefined;
    expect(first?.description).toBe("page heading");
  });
});
