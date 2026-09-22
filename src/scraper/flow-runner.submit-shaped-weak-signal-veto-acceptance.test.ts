import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-002 (recon-clickfilter-overlay-click-not-forwarded-to-hidden-
 * submit.md, "Requested item 2"): the n+16 fallback's weak-signal OR-branch
 * only excludes formValueChanged/textChanged/htmlDelta-only credit for a
 * step when `submitStep || (isFinalStep && flowHasSubmitSemanticsFlag)` is
 * true — authoritative-only off the flow author's explicit `submitStep:
 * true` flag. A step whose resolved control is objectively a submit
 * affordance (an HTML `type="submit"` control) but which the flow never
 * flagged falls through as an ordinary field-answer step, so a byte-positive
 * form RESET and a byte-positive real submit satisfy the weak-signal
 * OR-branch identically — the reported `network=false url=false
 * verified=true` defect.
 *
 * Both fixtures below are UNFLAGGED, non-final click steps (an interior step
 * followed by a second, harmless step) so `isFinalStep` and
 * `flowHasSubmitSemanticsFlag` are both false — isolating the new
 * attribute-based signal from the existing flag/final-step exclusions.
 *
 * Stagehand's own `act()` never touches the DOM (mocked, matching every
 * other offline acceptance test in this suite), so only the n+16 fallback's
 * own `el.click()` can produce a DOM effect, forcing the cascade through the
 * exact code path under test (`weakDomSignalsAllowed` /
 * `retryResolvedElementIsSubmitShaped`).
 */

const BASE_URL = "https://apply.example.com/step/1";
const SUBMIT_STEP_INSTRUCTION = "Click the button to continue";
const HARMLESS_SECOND_STEP = "Click the 'Details' link";

function makeLogger(): { logger: Logger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn((msg: string) => warn.push(msg)),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info, warn };
}

function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

/**
 * Builds the shared offline fixture: a two-step flow whose first step's
 * `el.click()` resolves via the n+16 fallback (Stagehand's own `act()` never
 * touches the DOM) against `bodyHtmlContent`, and whose second step is a
 * harmless no-op click so the first step's isolated verification decision
 * (not last-step veto/escalation noise) is what's asserted on.
 */
function buildFixture(params: {
  controlTag: string;
  controlAttrs: string;
  wrapInForm: boolean;
  clickHandler: (document: {
    getElementById: (id: string) => HappyDomElement | null;
    createElement: (tag: string) => HappyDomElement;
  }) => void;
}): {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  const formOpenTag = params.wrapInForm ? '<form id="theForm">' : "<div>";
  const formCloseTag = params.wrapInForm ? "</form>" : "</div>";
  document.body.innerHTML = `
    <div class="wizardFooter">
      ${formOpenTag}
        <${params.controlTag} id="theControl" ${params.controlAttrs}>Continue</${params.controlTag}>
      ${formCloseTag}
      <a id="detailsLink" href="#details">Details</a>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
  if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

  const controlXPath = absoluteXPathFor(controlEl);
  const detailsLinkXPath = absoluteXPathFor(detailsLinkEl);

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () =>
    params.clickHandler(
      document as unknown as {
        getElementById: (id: string) => HappyDomElement | null;
        createElement: (tag: string) => HappyDomElement;
      }
    )
  );

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => BASE_URL,
    title: async () => "Apply — Step 1",
    locator: () => ({
      first: () => ({
        click: async () => {
          (controlEl as unknown as { click: () => void }).click();
        },
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const stagehand: Stagehand = {
    // Stagehand's own act() never touches the DOM, so only n+16's own click
    // delivery can produce a real DOM effect for either step.
    act: vi.fn().mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
    })),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  void detailsLinkXPath;

  const steps: HealingFlowStep[] = [
    { instruction: SUBMIT_STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
    { instruction: HARMLESS_SECOND_STEP, optional: true, upload: false, submitStep: false },
  ];

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, steps, logger, info, warn };
}

/**
 * Sibling regression, distinct mechanism from the n+16 suite above: pins
 * that the stronger-signal requirement for a `submitStep: true` step
 * (network call, URL change, or the Haiku `verifySubmitWithLLM` judge)
 * applies unconditionally — not only when `requireSubmitEndpoint` happens
 * to be true because a `submitEndpointPattern` was configured
 * (flow-runner.ts's `requireSubmitEndpoint = (isFinalStep || submitStep) &&
 * submitEndpointPattern !== null`). When no pattern is configured, the
 * judge that (per its own docstring) enforces "network/URL/title
 * post-submit signal, not formValueChanged alone" never runs at all, so a
 * `submitStep` whose resolved action reports a state-class method (`fill`)
 * with a formValueSignature delta — the exact `network=false url=false ...
 * verified=true` shape from the report — rides the
 * `verified = ... || (clickViewSwapVerified || formValueVerified)` union
 * straight through uncontested.
 *
 * Both arms below share the identical fixture (same act()/evaluate
 * responses); only `submitEndpointPattern` differs, isolating the judge
 * gate itself as the variable under test rather than any other signal.
 */
describe("flow-runner submit-shaped step — weak-signal (formValueChanged-only) veto applies regardless of submitEndpointPattern configuration", () => {
  const SUBMIT_ONLY_STEP = "Click the 'Submit Application' button";

  interface JudgeGateSequenceState {
    url: string;
    bodyHtmlLength: number;
    visibleText: string;
    values: string;
    invalidMarkerCount: number;
  }

  function makeJudgeGatePage(state: JudgeGateSequenceState): Page {
    const session = { on: () => {}, off: () => {} };
    return {
      evaluate: async (expr: unknown) => {
        const src = String(expr);
        if (src.includes("outerHTML") && src.includes("innerText")) {
          return {
            html: state.bodyHtmlLength,
            text: `${state.bodyHtmlLength}:${state.visibleText}`,
            values: state.values,
          };
        }
        if (src.includes("isInvalid(el)")) return state.invalidMarkerCount;
        return null;
      },
      url: () => state.url,
      title: async () => "Apply | Submit Application",
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          // Deliberately returns "" — never matching the fill's expected
          // argument — so verifyDomEffect's own `hit` check is always
          // false, keeping the fixture's only credit path formValueVerified.
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
  }

  /**
   * Fake `Stagehand`: `act()` resolves the flagged submit step as a
   * successful `fill` (state-class method) that never touches network or
   * URL but does grow the DOM and change the form-value/text signatures —
   * modeling a form RESET rather than a genuine submit, structurally
   * identical to a real submit from network/url alone.
   */
  function makeJudgeGateStagehand(state: JudgeGateSequenceState): Stagehand {
    return {
      act: vi.fn().mockImplementation(async () => {
        state.bodyHtmlLength += 1250;
        state.visibleText = "form cleared";
        state.values = "reset";
        return {
          success: true,
          message: "filled",
          actionDescription: SUBMIT_ONLY_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=hiddenSubmitField]",
              description: "Submit Application",
              method: "fill",
              arguments: ["x"],
            },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;
  }

  function buildJudgeGateSteps(): HealingFlowStep[] {
    return [{ instruction: SUBMIT_ONLY_STEP, optional: false, upload: false, submitStep: true }];
  }

  it.each([
    ["no submitEndpointPattern configured", undefined],
    ["a submitEndpointPattern IS configured", "/api/apply/submit"],
  ])(
    "does NOT credit the submit step as verified from formValueChanged/textChanged/htmlDelta alone, network=false url=false, when %s",
    async (_label, submitEndpointPattern) => {
      const state: JudgeGateSequenceState = {
        url: BASE_URL,
        bodyHtmlLength: 40_000,
        visibleText: "",
        values: "initial",
        invalidMarkerCount: 0,
      };

      const stagehand = makeJudgeGateStagehand(state);
      const page = makeJudgeGatePage(state);
      const { logger, info } = makeLogger();

      await expect(
        runHealingFlow({
          stagehand,
          page,
          steps: buildJudgeGateSteps(),
          logger,
          anthropic: null,
          rephraseModel: null,
          uploadFixture: null,
          submitEndpointPattern: submitEndpointPattern ?? null,
        })
      ).rejects.toBeTruthy();

      expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
    }
  );
});

describe("flow-runner n+16 fallback — submit-shaped weak-signal veto (offline fixture, live happy-dom, no network)", () => {
  it("does NOT credit an UNFLAGGED, non-final step whose resolved control is a genuine HTML submit affordance on formValueChanged/textChanged/htmlDelta alone", async () => {
    // A byte-positive form RESET: the click handler clears the form's own
    // markup down to nothing observable via network/url, structurally
    // identical (from network/url/htmlDelta/textChanged alone) to a real
    // submit's DOM churn.
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "button",
      controlAttrs: 'type="submit"',
      wrapInForm: true,
      clickHandler: (document) => {
        const form = document.getElementById("theForm");
        if (form) form.innerHTML = `<div data-reset="${"x".repeat(2000)}"></div>`;
      },
    });

    try {
      const result = await runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      });
      // The submit-shaped step must NOT be credited as verified from the weak
      // DOM-only signal alone — it must not advance past step 0.
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies, so the (non-optional) step throws.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });

  it("still verifies the SAME weak-signal shape on a genuinely non-submit control (no regression to view-swap/reveal credit)", async () => {
    // Sibling case: an accordion toggle — same html/text-delta shape, but the
    // resolved control is an ordinary div, not a submit affordance.
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "div",
      controlAttrs: 'role="button" tabindex="0"',
      wrapInForm: false,
      clickHandler: (document) => {
        const control = document.getElementById("theControl");
        if (control) {
          const marker = document.createElement("div");
          marker.setAttribute("data-expanded", "x".repeat(2000));
          control.appendChild(marker);
        }
      },
    });

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(1);
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(true);
  });
});
