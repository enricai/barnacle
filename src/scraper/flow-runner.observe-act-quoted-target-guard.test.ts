import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act branch must refuse a candidate that does not match the
 * control quoted in the step, without refusing fill/select steps whose
 * candidates are legitimately described by field or widget type.
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
    evaluate: vi.fn().mockImplementation(async () => {
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
    evaluate: vi.fn().mockImplementation(async () => {
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

const URL = "https://apply.acme.example/jobs/1/apply";

type Step = Parameters<typeof runHealingFlow>[0]["steps"][number];

function stubObserve(description: string): void {
  guardedObserve.mockResolvedValue([
    { selector: "xpath=//*[@id='c']", description, method: "click", arguments: [] },
  ]);
}

function stubActFailsForStrings(): void {
  guardedAct.mockImplementation(async (_s, instructionOrTarget) => {
    if (typeof instructionOrTarget === "string") {
      return { success: false, message: "no candidates", actionDescription: "", actions: [] };
    }
    return {
      success: true,
      message: "ok",
      actionDescription: "acted",
      actions: [instructionOrTarget],
    };
  });
}

async function run(instruction: string): Promise<{ ok: boolean }> {
  const urls = { current: URL };
  resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
  const step: Step = { instruction, optional: false, upload: false, submitStep: false };
  try {
    await runHealingFlow({
      stagehand: makeStagehand(),
      page: makeFakePage(urls),
      steps: [step],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function targetActs(): unknown[][] {
  return guardedAct.mock.calls.filter((c) => typeof c[1] === "object" && c[1] !== null);
}

function loggedInfo(): string {
  return (testLogger.info as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join("\n");
}

describe("flow-runner/executeStepWithHealing — observe-act quoted-target guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    stubActFailsForStrings();
  });

  it("refuses a lone candidate that misses the quoted control and lets the cascade proceed", async () => {
    stubObserve("Click the Sign in with email button");
    await run(
      "Under the text 'Don't have an account yet?', click the 'Create Account' button to switch to account registration"
    );
    expect(targetActs()).toHaveLength(0);
    expect(loggedInfo()).toContain("does not match the control named in the step");
    expect(loggedInfo()).toContain("attempt 3");
  });

  it("acts on a lone candidate that matches the quoted control", async () => {
    stubObserve("Click the Create Account button");
    await run("Click the 'Create Account' button");
    expect(targetActs().length).toBeGreaterThan(0);
  });

  it("does not refuse a fill step whose candidate is described by field type", async () => {
    stubObserve("Password input");
    await run("Fill in the Password field with 'x'");
    expect(loggedInfo()).not.toContain("does not match the control named in the step");
  });

  it("does not refuse a select step whose candidate is described by widget type", async () => {
    stubObserve("Phone Device Type dropdown button");
    await run("In the 'Phone Device Type' prompt selector, select 'Mobile'");
    expect(loggedInfo()).not.toContain("does not match the control named in the step");
  });
});
