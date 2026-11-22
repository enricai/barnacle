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
const QUOTED_STEP =
  "Click on the 'Application Questions' page heading (an empty, non-interactive spot) to close any dropdown or prompt list that is still open";
let STEP = QUOTED_STEP;
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
  // The rephrased instruction is observed (resolved without acting) so it can be vetted
  // before any click; it resolves to the same element a string act would have clicked.
  guardedObserve
    .mockResolvedValueOnce([
      { selector: "xpath=//*[@id='h']", description: "page heading", method: "click" },
    ])
    .mockImplementation(async (_s: unknown, instruction: unknown) =>
      instruction === REPHRASED
        ? [{ selector: "xpath=//*[@id='t']", description, method: "click" }]
        : instruction === STEP
          ? [{ selector: "xpath=//*[@id='h']", description: "page heading", method: "click" }]
          : []
    );
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
      : instruction === REPHRASED ||
          (instruction as { selector?: string })?.selector === "xpath=//*[@id='t']"
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

let OPTIONAL = true;
async function runOptionalStep(): Promise<void> {
  await runHealingFlow({
    stagehand: {} as unknown as Stagehand,
    page: makeFakePage(),
    steps: [{ instruction: STEP, optional: OPTIONAL, upload: false, submitStep: false }],
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
    STEP = QUOTED_STEP;
    OPTIONAL = true;
  });

  it("attempt 1 never acts on the raw step when it resolves to an interactive control", async () => {
    guardedObserve
      .mockResolvedValueOnce([
        { selector: "xpath=//*[@id='h']", description: "page heading", method: "click" },
      ])
      .mockImplementation(async (_s: unknown, instruction: unknown) =>
        instruction === STEP
          ? [
              {
                selector: "xpath=//*[@id='b']",
                description: "language menu button",
                method: "click",
              },
            ]
          : []
      );
    guardedAct.mockResolvedValue({
      success: false,
      message: "x",
      actionDescription: "",
      actions: [],
    });
    generateObject.mockResolvedValue({ object: { outcome: "impossible" }, usage: {} });
    await runOptionalStep().catch(() => undefined);
    expect(guardedAct.mock.calls.some((c) => c[1] === STEP)).toBe(false);
    expect(
      guardedAct.mock.calls.some(
        (c) => (c[1] as { selector?: string })?.selector === "xpath=//*[@id='b']"
      )
    ).toBe(false);
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

    // Vetted before acting: neither the rephrased string nor the control Action is ever clicked.
    expect(guardedAct.mock.calls.some((c) => c[1] === REPHRASED)).toBe(false);
    expect(
      guardedAct.mock.calls.some(
        (c) => (c[1] as { selector?: string })?.selector === "xpath=//*[@id='t']"
      )
    ).toBe(false);
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("skips an optional step whose rephrase heal is evidenced only by a view-swap", async () => {
    wireRephraseResolvesTo("Application Questions page heading");

    await expect(runOptionalStep()).resolves.toBeUndefined();

    expect(logged("info")).toMatch(
      /skipped \(optional, llm-rephrase credited only by view-swap; network=false url=false dom=false\)/
    );
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("still credits a required step whose rephrase resolves to the quoted heading", async () => {
    OPTIONAL = false;
    wireRephraseResolvesTo("Application Questions page heading");

    await expect(runOptionalStep()).resolves.toBeUndefined();

    expect(logged("info")).toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("does not credit a required quoted-heading step whose rephrase resolves to a menu button", async () => {
    OPTIONAL = false;
    wireRephraseResolvesTo("language selector menu button");

    await expect(runOptionalStep()).rejects.toMatchObject({ kind: "cascade-exhausted" });
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("names the control only in the act's own description, not on the action", async () => {
    wireRephraseResolvesTo("language selector menu button");
    const wired = guardedAct.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    guardedAct.mockImplementation(async (...args: unknown[]) =>
      args[1] === REPHRASED
        ? {
            success: true,
            message: "ok",
            actionDescription: "language selector menu button",
            actions: [{ selector: "xpath=//*[@id='t']", method: "click" }],
          }
        : wired(...args)
    );

    await expect(runOptionalStep()).rejects.toMatchObject({ kind: "cascade-exhausted" });
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("refuses (and never acts) when observing the rephrase throws", async () => {
    wireRephraseResolvesTo("Application Questions page heading");
    const wired = guardedObserve.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    guardedObserve.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === REPHRASED) throw new Error("observe blew up");
      return wired(...args);
    });

    await expect(runOptionalStep()).rejects.toMatchObject({ kind: "cascade-exhausted" });
    expect(guardedAct.mock.calls.some((c) => c[1] === REPHRASED)).toBe(false);
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  it("rejects a vetted rephrase whose act then lands on a control", async () => {
    wireRephraseResolvesTo("Application Questions page heading");
    const wired = guardedAct.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    guardedAct.mockImplementation(async (...args: unknown[]) =>
      (args[1] as { selector?: string })?.selector === "xpath=//*[@id='t']"
        ? {
            success: true,
            message: "ok",
            actionDescription: "clicked",
            actions: [
              {
                selector: "xpath=//*[@id='m']",
                description: "language selector menu button",
                method: "click",
              },
            ],
          }
        : wired(...args)
    );

    await expect(runOptionalStep()).rejects.toMatchObject({ kind: "cascade-exhausted" });
    expect(logged("info")).not.toMatch(/healed on attempt \d+ via llm-rephrase/);
  });

  describe("a step with no quoted target that declares a blank, non-interactive spot", () => {
    beforeEach(() => {
      STEP = "Click on a blank area of the page to dismiss any open dropdown";
    });

    it("is not credited when the click lands on a control", async () => {
      guardedObserve.mockResolvedValue([
        { selector: "xpath=//*[@id='m']", description: "settings menu button", method: "click" },
      ]);
      guardedAct.mockResolvedValue({
        success: true,
        message: "ok",
        actionDescription: "clicked",
        actions: [
          { selector: "xpath=//*[@id='m']", description: "settings menu button", method: "click" },
        ],
      });
      generateObject.mockResolvedValue({
        object: { outcome: "impossible", reason: "x" },
        usage: {},
      });

      await expect(runOptionalStep()).rejects.toMatchObject({ kind: "cascade-exhausted" });
      expect(logged("info")).not.toMatch(/succeeded on attempt \d+ via act-string/);
    });

    it("is still credited when the click lands on static content", async () => {
      guardedObserve.mockResolvedValue([
        { selector: "xpath=//*[@id='h']", description: "page heading", method: "click" },
      ]);
      guardedAct.mockResolvedValue({
        success: true,
        message: "ok",
        actionDescription: "clicked",
        actions: [{ selector: "xpath=//*[@id='h']", description: "page heading", method: "click" }],
      });

      await expect(runOptionalStep()).resolves.toBeUndefined();
      expect(logged("info")).toMatch(/succeeded on attempt 1 via act-string/);
    });
  });
});
