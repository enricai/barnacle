import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RephraseModel } from "@/lib/llm/anthropic-client";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * A step that names a non-interactive spot (a quoted page heading) must not be
 * healed by an llm-rephrase that resolves to an unrelated interactive control.
 * Such a resolution is rejected (not credited) and the optional step is skipped;
 * a rephrase that resolves to the quoted heading is still credited.
 */

const generateObject = vi.fn();
const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

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

const FRAME_SELECTOR = "iframe#apply_frame";
const URL = "https://apply.acme.example/jobs/1/apply";
const STEP =
  "Click on the 'Application Questions' page heading (an empty, non-interactive spot) to close any dropdown or prompt list that is still open";
const REPHRASED = "click the page header";

function snapshotEvaluator() {
  let n = 0;
  return vi.fn().mockImplementation(async (expr: unknown) => {
    const centred = answerCentreHitTest(expr);
    if (centred) return centred;
    n++;
    return { html: n * 1000, text: `${n}:value-${n}` };
  });
}

function makeChildFrameTarget(): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: snapshotEvaluator(),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve(URL),
    title: () => Promise.resolve("Apply"),
  };
}

function makeFakePage(): Page {
  return {
    evaluate: snapshotEvaluator(),
    deepLocator: vi.fn(),
    url: () => URL,
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

/** Every string act fails except the rephrased one, which resolves to `description`. */
function wireRephraseResolvesTo(description: string): void {
  // The pre-cascade probe sees one candidate (so the optional step is not skipped as
  // "absent"); every later observe is empty.
  guardedObserve
    .mockResolvedValueOnce([
      { selector: "xpath=//*[@id='h']", description: "page heading", method: "click" },
    ])
    .mockResolvedValue([]);
  guardedAct.mockImplementation(async (_s: unknown, instruction: unknown) =>
    instruction === STEP
      ? {
          // Resolves a selector but does not succeed, so the cascade has "tried" something.
          success: false,
          message: "not verified",
          actionDescription: "",
          actions: [
            { selector: "xpath=//*[@id='h']", description: "page heading", method: "click" },
          ],
        }
      : instruction === REPHRASED
        ? {
            success: true,
            message: "ok",
            actionDescription: "clicked",
            actions: [{ selector: "xpath=//*[@id='t']", description, method: "click" }],
          }
        : { success: false, message: "no candidates", actionDescription: "", actions: [] }
  );
  generateObject.mockResolvedValue({
    object: { outcome: "rephrased", instruction: REPHRASED },
    usage: {},
  });
}

async function runOptionalStep(): Promise<void> {
  await runHealingFlow({
    stagehand: {} as unknown as Stagehand,
    page: makeFakePage(),
    steps: [{ instruction: STEP, optional: true, upload: false, submitStep: false }],
    logger: testLogger,
    anthropic: null,
    rephraseModel: { modelId: "test-model" } as unknown as RephraseModel,
    uploadFixture: null,
    frameSelector: FRAME_SELECTOR,
  });
}

function logged(level: "info"): string {
  return (testLogger[level] as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join("\n");
}

describe("flow-runner — targetless quoted-heading step, llm-rephrase resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    resolveFrameTarget.mockResolvedValue(makeChildFrameTarget());
  });

  it("rejects a rephrase that resolves to an unrelated menu button instead of crediting it", async () => {
    wireRephraseResolvesTo("language selector menu button");

    // Not credited: the cascade exhausts with the kind the optional-step skip policy
    // keys on, rather than the step being reported healed.
    // The optional-step skip is decided by the caller from this error kind (recon-browser
    // treats it as a replan/skip point); runHealingFlow must surface it, not swallow it
    // as a success or a "skipped" step, and must not use the probe-absent kind.
    const err = await runOptionalStep().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ kind: "cascade-exhausted" });
    expect(err).not.toMatchObject({ kind: "probe-absent" });
    expect(logged("info")).not.toMatch(/skipped \(optional, probe found no candidates\)/);

    expect(guardedAct.mock.calls.some((c) => c[1] === REPHRASED)).toBe(true);
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("still credits a rephrase that resolves to the quoted heading", async () => {
    wireRephraseResolvesTo("Application Questions page heading");

    await expect(runOptionalStep()).resolves.toBeUndefined();

    expect(logged("info")).toMatch(/healed on attempt \d+ via llm-rephrase/);
  });
});
