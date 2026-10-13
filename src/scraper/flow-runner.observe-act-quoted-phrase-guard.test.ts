import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * The observe-act branch (attempt 2/4) must not act on observe()'s first
 * candidate when the step quotes a control the candidate does not name.
 * observe() returns its best guess even when nothing matches, so the cascade
 * vets candidates against the quoted phrases and records a refusal instead.
 * Fill and select steps carry their own parsers and are exempt.
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

const CLICK_INSTRUCTION =
  "Under the text 'Don't have an account yet?', click the 'Create Account' button to switch to account registration";

const CLICK_FAILURE = {
  success: false,
  message: "no candidates",
  actionDescription: "",
  actions: [],
};

const REFUSAL = "does not match the control named in the step";

/** Runs one step and tolerates cascade exhaustion: the tests assert on act calls and logged refusals, not on verification. */
async function runStep(instruction: string, urls: { current: string }): Promise<void> {
  await runHealingFlow({
    stagehand: makeStagehand(),
    page: makeFakePage(urls),
    steps: [{ instruction, optional: false, upload: false, submitStep: false }],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    frameSelector: FRAME_SELECTOR,
  }).catch(() => undefined);
}

function loggedLines(): string[] {
  return (testLogger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
    String(c[0])
  );
}

function targetCalls(): unknown[][] {
  return guardedAct.mock.calls.filter(
    (call) => typeof call[1] === "object" && call[1] !== null && "method" in call[1]
  );
}

function candidate(description: string, method = "click"): Record<string, unknown> {
  return {
    selector: `xpath=//*[@aria-label='${description}']`,
    description,
    method,
    arguments: [],
  };
}

function actSucceedsOnTarget(urls: { current: string }): void {
  guardedAct.mockImplementation(async (_stagehand, instructionOrTarget) => {
    if (typeof instructionOrTarget === "string") return CLICK_FAILURE;
    urls.current = `${urls.current}/done`;
    return {
      success: true,
      message: "ok",
      actionDescription: "done",
      actions: [instructionOrTarget],
    };
  });
}

describe("flow-runner/executeStepWithHealing — observe-act quoted-phrase guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("refuses a lone candidate that misses the quoted control and reaches attempt 3", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([candidate("Click the Sign in with email button")]);
    guardedAct.mockResolvedValue(CLICK_FAILURE);

    await runStep(CLICK_INSTRUCTION, urls);

    expect(targetCalls()).toHaveLength(0);
    const lines = loggedLines();
    expect(lines.some((l) => l.includes("attempt 2:") && l.includes(REFUSAL))).toBe(true);
    expect(lines.some((l) => l.includes("attempt 3"))).toBe(true);
  });

  it("acts on a lone candidate that names the quoted control", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([candidate("Click the Create Account button")]);
    actSucceedsOnTarget(urls);

    await runStep(CLICK_INSTRUCTION, urls);

    expect(targetCalls().length).toBeGreaterThan(0);
    expect((targetCalls().at(0)?.[1] as { description?: string } | undefined)?.description).toBe(
      "Click the Create Account button"
    );
  });

  it("chooses the best-scoring candidate when several are returned", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([
      candidate("Click the Sign in with email button"),
      candidate("Click the Create Account button"),
    ]);
    actSucceedsOnTarget(urls);

    await runStep(CLICK_INSTRUCTION, urls);

    expect(targetCalls().length).toBeGreaterThan(0);
    expect((targetCalls().at(0)?.[1] as { description?: string } | undefined)?.description).toBe(
      "Click the Create Account button"
    );
  });

  it("does not refuse a fill step whose candidate is described differently from the field", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([candidate("Password input")]);
    actSucceedsOnTarget(urls);

    await runStep("Fill in the Password field with 'x'", urls);

    expect(targetCalls().length).toBeGreaterThan(0);
    expect((targetCalls()[0]?.[1] as { method: string } | undefined)?.method).toBe("fill");
    expect(loggedLines().some((l) => l.includes(REFUSAL))).toBe(false);
  });

  it("does not refuse a select step whose candidate is a dropdown button", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([candidate("Select Device Type dropdown button")]);
    actSucceedsOnTarget(urls);

    await runStep("In the 'Phone Device Type' prompt selector, select 'Mobile'", urls);

    expect(targetCalls().length).toBeGreaterThan(0);
    expect(loggedLines().some((l) => l.includes(REFUSAL))).toBe(false);
  });

  it("refuses the wrong candidate again at attempt 4 after attempt 3 fails", async () => {
    const urls = { current: "https://apply.acme.example/login" };
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget(urls));
    guardedObserve.mockResolvedValue([candidate("Click the Sign in with email button")]);
    guardedAct.mockResolvedValue(CLICK_FAILURE);

    await runStep(CLICK_INSTRUCTION, urls);

    expect(targetCalls()).toHaveLength(0);
    expect(loggedLines().some((l) => l.includes("attempt 4:") && l.includes(REFUSAL))).toBe(true);
  });
});
