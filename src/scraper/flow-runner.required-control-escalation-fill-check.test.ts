import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeDeepLocator } from "@/scraper/deep-locator-fake";
import type { HealingFlowStep } from "@/scraper/flow-runner";
import { parseCheckStep, resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the fix widening `hasUnfilledRequiredControlForStep`'s
 * label source beyond `parseSelectStep` (which only matches "select …"
 * phrasing) to also cover fill and checkbox instructions — see
 * flow-runner.ts's `extractRequiredControlProbeLabel`. Mirrors the existing
 * select-step escalation coverage in flow-runner.step-frame-scope.test.ts
 * ("threads the resolved child FrameTarget into the attempt-2
 * hasUnfilledRequiredControlForStep fast-skip guard") but with fill/check
 * phrased instructions, which previously short-circuited to `false` without
 * ever probing the DOM.
 */

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

/** Child `FrameTarget` whose `evaluate` answers the required-control probe (keyed on "isRequired", matching the probe's own DOM-query body) and no other DOM-direct call this fixture reaches. */
function makeChildFrameTarget(
  frameSelector: string,
  getUrl: () => string,
  opts: { hasUnfilledRequiredControl?: boolean } = {}
): FrameTarget {
  const { hasUnfilledRequiredControl = false } = opts;
  const evaluate = vi.fn(async (expr: unknown) => {
    const source = String(expr);
    if (source.includes("isRequired")) {
      return hasUnfilledRequiredControl;
    }
    if (source.includes("html:") && source.includes("text:")) {
      return { html: 0, text: "0:" };
    }
    if (source.includes('querySelectorAll("[class],[aria-invalid]")')) {
      return 0;
    }
    return null;
  });
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector,
    evaluate: evaluate as FrameTarget["evaluate"],
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve(getUrl()),
    title: () => Promise.resolve("Apply"),
  };
}

function fakeFlowPage(getUrl: () => string): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
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

describe("parseCheckStep", () => {
  it("extracts the quoted label from a Check-phrased checkbox step", () => {
    expect(parseCheckStep("Check the 'I Agree' checkbox")).toEqual({ label: "I Agree" });
  });

  it("extracts the quoted label from a Click-phrased checkbox step", () => {
    expect(
      parseCheckStep("Click the 'No' checkbox for 'Please indicate if you are Hispanic or Latino'")
    ).toEqual({ label: "No" });
  });

  it("returns null for a non-checkbox instruction", () => {
    expect(parseCheckStep("Fill in the middle name field")).toBeNull();
  });
});

describe("flow-runner/executeStepWithHealing — required-control escalation for fill/check instructions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it.each([
    ["fill", "Fill in the verifyPassword field with 'Str0ngPass!'"],
    ["check", "Check the 'I Agree' checkbox"],
  ])(
    "escalates the attempt-2 fast-skip guard for a %s-phrased instruction when a required, empty matching control is present",
    async (_kind, instruction) => {
      const urls = { current: "https://apply.acme.example/jobs/1/apply" };
      const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
        hasUnfilledRequiredControl: true,
      });
      resolveFrameTarget.mockResolvedValue(childTarget);

      const stagehand = makeStagehand();
      const page = fakeFlowPage(() => urls.current);

      // Pre-cascade probe must find a candidate so the step proceeds into
      // the attempt loop instead of fast-skipping via the SEPARATE
      // probe-absent guard. Attempt 1 (act-string) then resolves nothing,
      // and attempt 2's observe also reports zero candidates — the exact
      // "no candidates after act+observe" precondition the attempt-2 guard
      // requires.
      guardedObserve
        .mockResolvedValueOnce([
          { selector: "input#target", description: instruction, method: "fill" },
        ])
        .mockResolvedValue([]);
      guardedAct.mockResolvedValue({
        success: false,
        message: "no candidates",
        actionDescription: "",
        actions: [],
      });

      await expect(
        runHealingFlow({
          stagehand,
          page,
          steps: [step({ instruction, optional: true })],
          logger: testLogger,
          anthropic: null,
          rephraseModel: null,
          uploadFixture: null,
          frameSelector: "iframe#apply_frame",
        })
      ).rejects.toThrow(/failed verification after \d+ attempts/);

      // Distinctive log line the attempt-2 guard emits ONLY when it does NOT
      // fast-skip — proves the guard was reached and evaluated true for this
      // fill/check-phrased instruction, not vacuously passed through by the
      // pre-fix `parsed?.questionLabel` short-circuit.
      expect(testLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "no candidates after act+observe but a required unfilled control matches; NOT skipping (continuing cascade)"
        )
      );
      const requiredControlCalls = (
        childTarget.evaluate as ReturnType<typeof vi.fn>
      ).mock.calls.filter(([expr]) => String(expr).includes("isRequired"));
      expect(requiredControlCalls.length).toBeGreaterThan(0);
    }
  );

  it("still fast-skips a fill/check-phrased optional step when no required control is present", async () => {
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const childTarget = makeChildFrameTarget("iframe#apply_frame", () => urls.current, {
      hasUnfilledRequiredControl: false,
    });
    resolveFrameTarget.mockResolvedValue(childTarget);

    const stagehand = makeStagehand();
    const page = fakeFlowPage(() => urls.current);
    const instruction = "Check the 'Newsletter opt-in' checkbox";

    guardedObserve
      .mockResolvedValueOnce([
        { selector: "input#target", description: instruction, method: "click" },
      ])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await runHealingFlow({
      stagehand,
      page,
      steps: [step({ instruction, optional: true })],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: "iframe#apply_frame",
    });

    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped (optional, no candidates after act+observe)")
    );
  });
});
