import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's own observed log line verbatim: "pre-submit probe: no
 * ng-invalid form controls detected" logged despite a provably empty
 * required field, because the SCAN phase of `FORM_VALIDITY_PROBE_EXPR` only
 * ever visits elements whose `class` attribute matches the closed set of
 * framework invalid markers (ng-invalid, Mui-error, etc) -- a required field
 * that has never been interacted with carries none of them.
 *
 * Executes the REAL `FORM_VALIDITY_PROBE_EXPR` template-literal string
 * against a genuine happy-dom `Window`/`Document`, mirroring the harness in
 * `flow-runner.form-validity-native-fallback.test.ts` -- a mocked
 * `evaluate` returning a canned result could never catch a defect in the
 * expression itself.
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

describe("flow-runner/probeFormValidityBeforeSubmit — pristine empty required field regression", () => {
  const testLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(
      (page: Page): FrameTarget => ({
        frame: null,
        frameSelector: null,
        evaluate: (pageFunctionOrExpression, arg) => page.evaluate(pageFunctionOrExpression, arg),
        locator: (selector) => page.locator(selector),
        url: () => Promise.resolve(page.url()),
        title: () => page.title(),
      })
    );
    guardedObserve.mockResolvedValue([
      { selector: "css=button#submit", description: "Submit button", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Submit button",
      actions: [{ selector: "css=button#submit", description: "Submit button", method: "click" }],
    });
  });

  function fakePage(): Page {
    return {
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      url: () => "https://forms.example.com/shipping-address/abc-123",
      title: vi.fn().mockResolvedValue("Shipping Address"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
  }

  it("flags a pristine, class-marker-free, empty required field and ignores a filled, class-marker-free, non-required control", async () => {
    const window = new Window({ url: "https://forms.example.com/shipping-address/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form>
        <label for="street_address">Street address</label>
        <input type="text" id="street_address" name="street_address" required />
        <label for="apartment_number">Apartment number</label>
        <input type="text" id="apartment_number" name="apartment_number" value="4B" />
      </form>
    `;

    let probeResult: unknown;
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: "iframe#shipping_frame",
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        const src = String(expr);
        if (src.includes("MARKERS")) {
          // FORM_VALIDITY_PROBE_EXPR: execute the ACTUAL production
          // expression string against the live happy-dom document.
          const fn = new Function("document", `return (${src});`) as (d: unknown) => unknown;
          probeResult = fn(document);
          return probeResult;
        }
        if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
        if (src === "location.href") return "https://forms.example.com/shipping-address/abc-123";
        return null;
      }) as FrameTarget["evaluate"],
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }) as unknown as FrameTarget["locator"],
      url: () => Promise.resolve("https://forms.example.com/shipping-address/abc-123"),
      title: () => Promise.resolve("Shipping Address"),
    };
    resolveFrameTarget.mockResolvedValue(childTarget);

    // The pre-submit probe fires before the act/verify portion of the
    // cascade; whether the submit itself is ultimately judged successful is
    // irrelevant to this regression, so the verification outcome is ignored.
    await executeStepWithHealing({
      stagehand: {} as unknown as Stagehand,
      page: fakePage(),
      step: "Click the Submit button",
      optional: false,
      upload: false,
      submitStep: true,
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
      isFinalStep: true,
      submitEndpointPattern: "/gq",
      submittedStateSelectors: ["uapp-universal-submitted-page"],
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
      frameTarget: childTarget,
    } as never).catch(() => undefined);

    expect(Array.isArray(probeResult)).toBe(true);
    const result = probeResult as Array<{ label: string; emptyOrUnchecked: boolean }>;
    expect(result.length).toBe(1);
    const [onlyEntry] = result;
    expect(onlyEntry?.label).toBe("Street address");
    expect(onlyEntry?.emptyOrUnchecked).toBe(true);
    expect(result.some((e) => e.label === "Apartment number")).toBe(false);

    const logged = (testLogger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(logged.some((l) => l.includes("no ng-invalid form controls detected"))).toBe(false);
    expect(
      logged.some((l) => l.includes("pre-submit probe: 1 ng-invalid form control(s) detected"))
    ).toBe(true);
  });
});
