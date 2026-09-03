import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeDeepLocator } from "@/scraper/deep-locator-fake";
import type { HealingFlowStep } from "@/scraper/flow-runner";
import {
  hasUnfilledRequiredControlForStep,
  parseCheckStep,
  resetBillingErrorFlagForTests,
  runHealingFlow,
} from "@/scraper/flow-runner";
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

/**
 * Real-DOM `FrameTarget` whose `evaluate` runs the guard's actual expression
 * string against a live happy-dom document — proves the fix against genuine
 * markup shapes, not a substring-matched mock.
 */
function makeDomFrameTarget(html: string): FrameTarget {
  const window = new Window({ url: "https://careers.example.com/apply" });
  const document = window.document;
  document.body.innerHTML = html;
  const evaluate = (async (expr: unknown) => {
    const fn = new window.Function("document", "window", "CSS", `return (${String(expr)});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  }) as FrameTarget["evaluate"];
  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: vi.fn() as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://careers.example.com/apply"),
    title: () => Promise.resolve("Apply"),
  };
}

describe("hasUnfilledRequiredControlForStep — prompt-selector widget family (real DOM)", () => {
  it("returns true for a deeply-nested multiselect input whose <label> sits 7 ancestor hops up", async () => {
    // Mirrors the evidence DOM's "source--source" input: aria-invalid + aria-required
    // on the control, but its <label> lives inside a wrapper 7 hops above the
    // input — past the old depth-6 ancestor cap. Standards-first label[for=id]
    // resolution (depth-independent) is what makes this reachable.
    const html = `
      <div id="formField-source">
        <label for="source--source">How Did You Hear About Us?</label>
        <div><div><div><div><div><div><div>
          <input id="source--source" aria-invalid="true" aria-required="true" value="" />
        </div></div></div></div></div></div></div>
      </div>
    `;
    const target = makeDomFrameTarget(html);
    await expect(
      hasUnfilledRequiredControlForStep(
        target,
        "Select 'Employee Referral' for 'How Did You Hear About Us?'"
      )
    ).resolves.toBe(true);
  });

  it("returns true for a button-only prompt trigger with an aria-label ending in 'Required' and no aria-required attribute", async () => {
    // Mirrors a country/phoneType single-select trigger: a plain
    // <button> with no native input/select and no aria-required, but the
    // 'required' marker baked as a text suffix into aria-label.
    const html = `
      <div id="formField-country">
        <span id="country-label">Country</span>
        <button id="country-trigger" aria-haspopup="listbox" aria-labelledby="country-label" aria-label="Country United States of America Required"></button>
      </div>
    `;
    const target = makeDomFrameTarget(html);
    await expect(
      hasUnfilledRequiredControlForStep(target, "Select 'United States of America' for 'Country'")
    ).resolves.toBe(true);
  });

  it("still returns true for a native required-and-empty input/select/textarea (existing coverage unchanged)", async () => {
    const html = `
      <div>
        <label for="middleName">Middle Name</label>
        <input id="middleName" required value="" />
      </div>
    `;
    const target = makeDomFrameTarget(html);
    await expect(
      hasUnfilledRequiredControlForStep(target, "Fill in the Middle Name field with 'Q'")
    ).resolves.toBe(true);
  });

  it("returns false when the required control is already filled", async () => {
    const html = `
      <div>
        <label for="middleName">Middle Name</label>
        <input id="middleName" required value="Q" />
      </div>
    `;
    const target = makeDomFrameTarget(html);
    await expect(
      hasUnfilledRequiredControlForStep(target, "Fill in the Middle Name field with 'Q'")
    ).resolves.toBe(false);
  });

  it("returns true for a composite opener+hidden-select widget whose container carries a non-vendor class name", async () => {
    // Same ARIA/DOM shape OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR recognizes
    // elsewhere in this file (role=combobox opener paired with a hidden
    // native select) — the opener itself carries no required/aria-required
    // marker (design systems typically only expose that on the opener via
    // a class-styled shell, not a native attribute), and the container class
    // is a made-up name that is neither of the hardcoded vendor literals
    // ("bb-custom-select-container", "MultiCheckboxInput") the old regex
    // looked for. Only the generic triggerSel-based opener detection — not
    // the vendor class name — makes this widget resolve as a real control.
    const requiredHtml = `
      <div id="formField-employmentType" class="totally-unbranded-widget-shell">
        <label id="employmentType-label">Employment Type</label>
        <button role="combobox" aria-haspopup="listbox" aria-owns="employmentType-listbox" aria-controls="employmentType-listbox" aria-labelledby="employmentType-label"></button>
        <select id="employmentType-select" style="display:none">
          <option value="">-</option>
        </select>
      </div>
    `;
    const requiredTarget = makeDomFrameTarget(requiredHtml);
    await expect(
      hasUnfilledRequiredControlForStep(requiredTarget, "Select 'Full-Time' for 'Employment Type'")
    ).resolves.toBe(true);

    // Sibling assertion: an ordinary container with the same non-vendor class
    // but no opener/trigger widget at all still resolves false — the fix
    // must not turn every non-vendor-classed container into a false positive.
    const optionalHtml = `
      <div id="formField-referralSource" class="totally-unbranded-widget-shell">
        <label for="referralSource-select">Referral Source</label>
        <select id="referralSource-select" style="display:none">
          <option value="">-</option>
        </select>
      </div>
    `;
    const optionalTarget = makeDomFrameTarget(optionalHtml);
    await expect(
      hasUnfilledRequiredControlForStep(optionalTarget, "Select 'Friend' for 'Referral Source'")
    ).resolves.toBe(false);
  });
});

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
