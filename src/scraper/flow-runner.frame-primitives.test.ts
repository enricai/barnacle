import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeDeepLocator, registerDeepLocatorHopElements } from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the 8 selector-less `resolveFrameTarget(page)`
 * call sites inside `executeStepWithHealing` that used to silently re-resolve
 * to the main frame instead of reusing the already-resolved ambient
 * `frameTarget` param: the upload-primitive target, the shared
 * `selectFrameTarget` (select/checkbox/required-selects primitives), the
 * pre-submit `probeFormValidityBeforeSubmit` target, the html5-date-fill +
 * fill-readback target, the structured-click probe target, `verifyDomEffect`'s
 * target, the submitted-state DOM probe target, and the n+16 native-click
 * fallback target. Each was reachable once a frame-scoped step actually
 * entered the iframe, so a mid-flow-mounted cross-origin iframe (the
 * the top-window site/the embedded apply wizard shape) would silently fall back to the top document for
 * every one of these primitives even though the enclosing step had already
 * resolved the child frame.
 *
 * Distinct from `flow-runner.frame-primitive-helpers.test.ts` (unit-tests the
 * DOM primitive helpers directly, doesn't drive the cascade),
 * `flow-runner.step-frame-scope.test.ts` / `flow-runner.frame-threading.test.ts`
 * (cover the attempt-1 pre-cascade sites that already correctly used
 * `frameTarget ?? mainFrameTarget(page)`), and
 * `flow-runner.submit-verify-frame-scope.test.ts` (covers the submit-verify
 * region's OTHER six sites, already fixed). Mocks `@/scraper/frame-target` and
 * `@/scraper/stagehand-guard` at the module boundary, same style as those
 * sibling files, so assertions are about WHICH `FrameTarget` object crosses
 * each call boundary — not about `resolveFrameTarget`'s own origin-matching.
 */

const resolveFrameTarget = vi.fn();
const mainFrameTarget = vi.fn();
const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
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

const CHILD_ORIGIN = "https://apply.example.com";
const FRAME_SELECTOR = "iframe#apply_frame";

/**
 * Builds a main-frame `FrameTarget` delegating straight to `page`, matching
 * `mainFrameTarget`'s real contract — the fallback half of every
 * `frameTarget ?? mainFrameTarget(page)` shim, deliberately a DISTINCT object
 * from `childTarget` so a call landing on it (instead of the resolved child)
 * is detectable via `toBe`/`not.toHaveBeenCalled`.
 */
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

/** Fake `Page`: only touched when a fix under test regresses back to `mainFrameTarget(page)`. */
function fakePage(getUrl: () => string = () => `${CHILD_ORIGIN}/application/abc-123`): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    // Empty registry (no hops registered) so deepLocator resolves 0
    // candidates by default — this suite's fixtures assert on today's
    // pre-deepLocator behavior, not the new frame-scoped fallback path.
    deepLocator: makeFakeDeepLocator(new Map()),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        setInputFiles: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Shared params every scenario passes to `executeStepWithHealing`; each test overrides only what its path needs. */
function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    stagehand: makeStagehand(),
    page: fakePage(),
    step: "Fill in the middle name field",
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
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
    ...overrides,
  };
}

describe("flow-runner/executeStepWithHealing — upload/select primitive frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into tryUploadPrimitive's target, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("input[type=file]").valueOf() && src.includes("length")) return 1;
      return null;
    });
    const setInputFiles = vi.fn().mockRejectedValue(new Error("no real DOM in this fixture"));
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi
        .fn()
        .mockReturnValue({ first: () => ({ setInputFiles }) }) as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    // Probe-before-attempts finds no candidate, but the upload primitive runs
    // BEFORE that probe unconditionally when `upload: true` — its own failure
    // (setInputFiles throws) falls through to the cascade, which then
    // legitimately fails; this test's only concern is which target the
    // upload primitive itself touched.
    guardedObserve.mockResolvedValue([]);

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          upload: true,
          uploadFixture: {
            buffer: Buffer.from("pdf-bytes"),
            name: "resume.pdf",
            mimeType: "application/pdf",
          },
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();

    // resolveFrameTarget must never be called: a frameTarget was already
    // threaded in, so the fixed code reuses it via `frameTarget ??
    // mainFrameTarget(page)` rather than re-resolving blind.
    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    expect(childEvaluate).toHaveBeenCalled();
    expect(setInputFiles).toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("main-frame control: tryUploadPrimitive dispatches via page when frameTarget is undefined", async () => {
    const page = fakePage();
    guardedObserve.mockResolvedValue([]);
    (page.locator as ReturnType<typeof vi.fn>).mockReturnValue({
      first: () => ({ setInputFiles: vi.fn().mockRejectedValue(new Error("no real DOM")) }),
    });
    (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("input[type=file]") && src.includes("length")) return 1;
      return null;
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          upload: true,
          uploadFixture: {
            buffer: Buffer.from("pdf-bytes"),
            name: "resume.pdf",
            mimeType: "application/pdf",
          },
          frameTarget: undefined,
        }) as never
      )
    ).rejects.toThrow();

    expect(mainFrameTarget).toHaveBeenCalledWith(page);
    expect(page.evaluate).toHaveBeenCalled();
  });

  it("threads the resolved child FrameTarget into the shared selectFrameTarget (select-primitive enumerate), not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("selectPresent")) return { selectPresent: false };
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();
    guardedObserve.mockResolvedValue([]);

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Select 'Yes' for 'Are you authorized to work in the US?'",
          optional: true,
          frameTarget: childTarget,
        }) as never
      )
    ).resolves.toBe("skipped");

    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const enumerateCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("selectPresent")
    );
    expect(enumerateCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — pre-submit form-validity probe frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into probeFormValidityBeforeSubmit, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("selectPresent")) return { selectPresent: false };
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("MARKERS")) return [];
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();
    // Pre-cascade probe (probeStepBeforeAttempts) must find a candidate so the
    // step proceeds past the probe-absent guard and reaches the
    // requireSubmitEndpoint-gated form-validity probe (which runs BEFORE the
    // attempt loop). Attempts 1-5 then exhaust on empty observe results.
    guardedObserve
      .mockResolvedValueOnce([
        { selector: "css=button#submit", description: "Submit button", method: "click" },
      ])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Click the Submit button",
          submitStep: true,
          submitEndpointPattern: "/gq",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();

    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const probeCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("MARKERS")
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — html5 date-fill / fill-readback frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
    guardedObserve.mockResolvedValue([
      { selector: "css=button#submit", description: "Submit button", method: "click" },
    ]);
  });

  it("threads the resolved child FrameTarget into fillHtml5DateTimeInput's target, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("selectPresent")) return { selectPresent: false };
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("HTMLInputElement.prototype")) {
        return { filled: true, postValue: "2026-06-14", inputType: "date" };
      }
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    // Attempt 1 (act-string) resolves no action -> fast-skips to attempt 2
    // (observe-act), which finds a fill-shaped candidate and routes into the
    // html5-date-fallback branch under test.
    guardedAct.mockResolvedValueOnce({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });
    guardedObserve
      .mockResolvedValueOnce([
        { selector: "css=button#submit", description: "Submit button", method: "click" },
      ])
      .mockResolvedValueOnce([
        {
          selector: "xpath=//input[@id='dob']",
          description: "Date of birth",
          method: "fill",
          arguments: ["06-14-2026"],
        },
      ]);
    guardedAct.mockResolvedValueOnce({
      success: false,
      message: "date fill failed via act",
      actionDescription: "",
      actions: [],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Fill in the date of birth field",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();

    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const dateFillCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("HTMLInputElement.prototype")
    );
    expect(dateFillCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — structured-click probe frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into the structured-click probe, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("isCheckable")) {
        return { resolved: true, isCheckable: false };
      }
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    // Attempt 1 and 2 resolve a click candidate with an xpath= selector but
    // never verify (no network/url/dom signal), so the cascade reaches
    // attempt 3 (structured-click) with a tried xpath= selector in scope.
    guardedObserve.mockResolvedValue([
      { selector: "xpath=//input[@id='agree']", description: "I agree", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "I agree",
      actions: [
        { selector: "xpath=//input[@id='agree']", description: "I agree", method: "click" },
      ],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Click the 'I agree' checkbox",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();

    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const structuredClickCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("isCheckable")
    );
    expect(structuredClickCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("keeps structured-click reachable at attempt 3 when trusted-click-retry's only deepLocator matches are all wizard-exit deny-listed", async () => {
    // Bug-1 regression. A non-submit phantom routes attempt 2 to
    // trusted-click-retry; if EVERY re-resolved deepLocator candidate is refused
    // by the wizard-exit deny-list, the walk records zero tried selectors of its
    // own. structured-click's `anyXpathResolved` precondition must still see the
    // xpath attempt-1 resolved (carried forward via the running triedSelectors),
    // so structured-click still runs at attempt 3 rather than being skipped.
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    // deepLocator resolves ONE candidate whose accessible text is a wizard-exit
    // control ("Continue Later"), which isWizardExitAction denies — so the
    // trusted-click-retry walk clicks nothing and its own attemptTriedSelectors
    // stays empty.
    const frame = new Map();
    registerDeepLocatorHopElements(
      frame,
      `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`,
      ["Continue Later"]
    );
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> *`, ["Continue Later"]);
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      deepLocator: makeFakeDeepLocator(frame),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          setInputFiles: vi.fn().mockResolvedValue(undefined),
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      url: () => `${CHILD_ORIGIN}/application/abc-123`,
      title: vi.fn().mockResolvedValue("Apply"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    // Attempt 1 (act-string) resolves an xpath and reports success but produces
    // no observable effect → phantom → attempt 2 = trusted-click-retry.
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "I agree",
      actions: [
        { selector: "xpath=//input[@id='agree']", description: "I agree", method: "click" },
      ],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Click the 'I agree' checkbox",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();

    const structuredClickCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("isCheckable")
    );
    expect(structuredClickCalls.length).toBeGreaterThan(0);
  });
});

describe("flow-runner/executeStepWithHealing — verifyDomEffect frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into verifyDomEffect, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("el.type || null")) return "checkbox";
      if (src.includes("el.checked")) return true;
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn().mockReturnValue({
        first: () => ({ isChecked: vi.fn().mockResolvedValue(true) }),
      }) as unknown as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    guardedObserve.mockResolvedValue([
      { selector: "xpath=//input[@id='agree']", description: "I agree", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "I agree",
      actions: [
        { selector: "xpath=//input[@id='agree']", description: "I agree", method: "click" },
      ],
    });

    const outcome = await executeStepWithHealing(
      baseParams({ page, step: "Click the 'I agree' checkbox", frameTarget: childTarget }) as never
    );

    expect(outcome).toBe("completed");
    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const verifyDomEffectCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("el.type || null")
    );
    expect(verifyDomEffectCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — submitted-state DOM probe frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into the top-level submitted-state DOM probe, not mainFrameTarget(page)", async () => {
    const urls = { current: `${CHILD_ORIGIN}/application/abc-123` };
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("document.querySelector(sel)")) return "[data-testid=thank-you]";
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(urls.current),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage(() => urls.current);

    guardedObserve.mockResolvedValue([
      { selector: "css=button#submit", description: "Submit button", method: "click" },
    ]);
    guardedAct.mockImplementation(async () => {
      urls.current = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Submit button",
        actions: [{ selector: "css=button#submit", description: "Submit button", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(
      baseParams({
        page,
        step: "Click the Submit button",
        submitStep: true,
        isFinalStep: true,
        submitEndpointPattern: "/gq",
        submittedStateSelectors: ["[data-testid=thank-you]"],
        frameTarget: childTarget,
      }) as never
    );

    expect(outcome).toBe("completed");
    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const submittedStateCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("document.querySelector(sel)")
    );
    expect(submittedStateCalls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/executeStepWithHealing — n+16 native-click fallback frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
  });

  it("threads the resolved child FrameTarget into the n+16 native-click fallback, not mainFrameTarget(page)", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      if (src.includes('el.click !== "function"')) return { fired: true, kind: "click" };
      if (src.includes("isInvalid(node)")) return false;
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    // Attempt 1's resolved click carries an xpath= selector (required for the
    // n+16 gate to arm) but never verifies (no network/url/dom signal), so
    // the cascade falls into the n+16 el.click() fallback within attempt 1.
    guardedObserve.mockResolvedValue([
      { selector: "xpath=//button[@id='next']", description: "Next", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Next",
      actions: [{ selector: "xpath=//button[@id='next']", description: "Next", method: "click" }],
    });

    await expect(
      executeStepWithHealing(
        baseParams({ page, step: "Click the Next button", frameTarget: childTarget }) as never
      )
    ).rejects.toThrow();

    expect(resolveFrameTarget).not.toHaveBeenCalled();
    expect(mainFrameTarget).not.toHaveBeenCalled();
    const n16Calls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes('el.click !== "function"')
    );
    expect(n16Calls.length).toBeGreaterThan(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  /**
   * Builds a childEvaluate mock for a checkbox-intent step (bugfix-001):
   * the n+16 clickExpr result is controlled by `n16Result`, and the DOM
   * snapshot expr (`b.outerHTML` — see `DOM_SNAPSHOT_EXPR`) returns a
   * form-value signature that differs pre/post ONLY when
   * `formValueChangedAcrossSnapshot` is true, simulating an unrelated field
   * changing on the same page (the reported false-positive) without the
   * target checkbox itself committing.
   */
  function checkboxIntentEvaluate(
    n16Result: { fired: boolean; kind?: string; checked?: boolean },
    formValueChangedAcrossSnapshot: boolean
  ) {
    let snapshotCalls = 0;
    return vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      if (src.includes('el.click !== "function"')) return n16Result;
      if (src.includes("isInvalid(node)")) return false;
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      if (src.includes("b.outerHTML")) {
        snapshotCalls += 1;
        const isPost = snapshotCalls > 1;
        const values = isPost && formValueChangedAcrossSnapshot ? "changed" : "";
        return { html: 100, text: "0:", values, state: "" };
      }
      return null;
    });
  }

  it("does NOT credit a checkbox-intent step on a weak formValueChanged signal alone when checkboxStateVerified is false", async () => {
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: checkboxIntentEvaluate({ fired: false }, true) as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@id='newsletter-opt-in']",
        description: "Newsletter opt-in checkbox",
        method: "click",
      },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Newsletter opt-in checkbox",
      actions: [
        {
          selector: "xpath=//input[@id='newsletter-opt-in']",
          description: "Newsletter opt-in checkbox",
          method: "click",
        },
      ],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Check the 'I agree to receive updates' checkbox",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();
  });

  it("DOES credit a checkbox-intent step when checkboxStateVerified is true", async () => {
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: checkboxIntentEvaluate(
        { fired: true, kind: "checkbox", checked: true },
        false
      ) as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@id='newsletter-opt-in']",
        description: "Newsletter opt-in checkbox",
        method: "click",
      },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Newsletter opt-in checkbox",
      actions: [
        {
          selector: "xpath=//input[@id='newsletter-opt-in']",
          description: "Newsletter opt-in checkbox",
          method: "click",
        },
      ],
    });

    const outcome = await executeStepWithHealing(
      baseParams({
        page,
        step: "Check the 'I agree to receive updates' checkbox",
        frameTarget: childTarget,
      }) as never
    );

    expect(outcome).toBe("completed");
  });

  it("does NOT credit a checkbox-intent step when the n+16 click resolves kind=checkbox checked=false, even with a page-wide htmlDelta/textChanged/formValueChanged all moving from an unrelated field", async () => {
    let snapshotCalls = 0;
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("groupPresent")) return { groupPresent: false };
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      if (src.includes('el.click !== "function"')) {
        return { fired: true, kind: "checkbox", checked: false };
      }
      if (src.includes("isInvalid(node)")) return false;
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      if (src.includes("b.outerHTML")) {
        snapshotCalls += 1;
        const isPost = snapshotCalls > 1;
        // Mirrors the doc's probe line: htmlDelta=-12, textChanged=false,
        // formValueChanged=true — an unrelated already-filled field's
        // signature drifting, not the target checkbox committing.
        return isPost
          ? { html: 88, text: "0:", values: "already-filled-field-changed", state: "" }
          : { html: 100, text: "0:", values: "", state: "" };
      }
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: childEvaluate as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@id='newsletter-opt-in']",
        description: "Newsletter opt-in checkbox",
        method: "click",
      },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Newsletter opt-in checkbox",
      actions: [
        {
          selector: "xpath=//input[@id='newsletter-opt-in']",
          description: "Newsletter opt-in checkbox",
          method: "click",
        },
      ],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Check the 'I agree to the Terms' checkbox",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();
  });

  it("does NOT credit a radio-intent step on a weak formValueChanged signal alone when checkboxStateVerified is false", async () => {
    // clickExpr classifies both checkbox and radio inputs under the same
    // kind:"checkbox" branch (el.type === "checkbox" || el.type === "radio"),
    // so a radio target's n+16 result also reports kind:"checkbox" — proving
    // the gate covers the radio leg of that shared classification branch.
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      evaluate: checkboxIntentEvaluate(
        { fired: true, kind: "checkbox", checked: false },
        true
      ) as FrameTarget["evaluate"],
      locator: vi.fn() as FrameTarget["locator"],
      url: () => Promise.resolve(`${CHILD_ORIGIN}/application/abc-123`),
      title: () => Promise.resolve("Apply"),
    };
    const page = fakePage();

    guardedObserve.mockResolvedValue([
      {
        selector: "xpath=//input[@id='contact-pref-email']",
        description: "Email contact-preference radio button",
        method: "click",
      },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Email contact-preference radio button",
      actions: [
        {
          selector: "xpath=//input[@id='contact-pref-email']",
          description: "Email contact-preference radio button",
          method: "click",
        },
      ],
    });

    await expect(
      executeStepWithHealing(
        baseParams({
          page,
          step: "Click the 'Email' radio button for the 'Contact preference' question",
          frameTarget: childTarget,
        }) as never
      )
    ).rejects.toThrow();
  });
});
