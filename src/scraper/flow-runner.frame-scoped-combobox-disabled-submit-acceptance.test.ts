import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance regression combining bugfix-001 (widened hidden-sibling commit
 * detection) and the disabled-submit veto, under the ONE structural element
 * neither existing generic-shape suite exercises: both widgets living inside
 * a resolved child frame (`FrameTarget.frameSelector` non-null), not the main
 * document. Every closest analogue —
 * `flow-runner.disabled-submit-blocked-by-uncommitted-selection.test.ts`,
 * `flow-runner.select-from-list-committed-control.test.ts`,
 * `flow-runner.combobox-role-trigger-classless-option-commit.test.ts`,
 * `flow-runner.dropdown-hidden-sibling-commit-widening.test.ts` — hand-builds
 * `FrameTarget`/`Page` with `frame: null, frameSelector: null`.
 *
 * Runs the REAL `runHealingFlow` through the REAL `resolveFrameTarget`, so
 * the fixture must supply a `Page` exposing `frames()`/`mainFrameId()` (the
 * `<iframe>` resolution surface `frame-target.ts` needs) and a child `Frame`
 * whose `evaluate` executes the real production expressions
 * (`SELECTION_STATE_MAP_EXPR`, `selectionSiblingCommittedValueChanged`,
 * `DISABLED_MARKER_EL_EXPR`, ...) against a live happy-dom document via
 * `window.Function` — mirroring
 * `flow-runner.disabled-submit-blocked-by-uncommitted-selection.test.ts`'s
 * "no internal helper hand-simulated" contract, just scoped one hop deeper.
 *
 * Two assertions, mirroring the recon report's step-7 shape one level inside
 * a child frame:
 *   1. The plan option click (inside the frame) is credited ONLY via the
 *      widened commit detection finding the option's REAL hidden
 *      committed-value sibling change inside the frame's own document —
 *      never via the untracked visible-label mutation.
 *   2. The subsequent disabled 'Continue' click (also inside the frame) is
 *      vetoed and never scored verified — the flow rejects with
 *      `StepVerificationError` and never reaches the step standing in for
 *      downstream progress.
 */

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example.com";
const IFRAME_SELECTOR = "iframe#planWidgetFrame";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123/billing`;

const NAME_STEP = "Fill in the 'Full Name' field with 'Jordan Alvarez'";
const PLAN_OPTION_STEP = "Click the 'Pro Plan' option in the plan combobox";
const COMPANY_STEP = "Fill in the 'Company Name' field with 'Acme Corp'";
/** 'Phone Number' is left empty, so 'Continue' stays disabled/aria-disabled — the report's step-7 shape, one frame deeper. */
const CONTINUE_STEP = "Click the 'Continue' button";
/** Stands in for downstream progress — must never run if the disabled 'Continue' click is (correctly) never credited. */
const UPLOAD_DOCS_STEP = "Click the 'Upload Documents' button";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** In-memory model of the frame-scoped widget's observable state. */
interface FrameWidgetState {
  childUrl: string;
  planOptionClickCount: number;
  continueClickCount: number;
  uploadDocsStepReached: boolean;
}

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps, no `@id`/`@name`. */
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

/** Best-effort flattening of an `act()` input into a string the fixture can pattern-match against. */
function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/**
 * Builds the child frame's own document — the combobox + disabled submit
 * gate live entirely inside here, never in the top document, matching the
 * recon's `frameSelector`-scoped shape.
 */
function buildChildDocument(): {
  window: Window;
  optionEl: HappyDomElement;
  triggerEl: HappyDomElement;
  hiddenValueInput: { value: string };
  continueEl: HappyDomElement;
  commitHandlerCalls: { n: number };
} {
  const window = new Window({ url: CHILD_SRC });
  const document = window.document;
  document.body.innerHTML = `
    <input data-automation-id="fullName" />
    <div class="PlanPickerContainer">
      <div role="combobox" aria-expanded="false" id="planTrigger">Select a plan</div>
      <ul role="listbox">
        <li role="option" id="planOptionPro">Select a plan</li>
      </ul>
      <input type="hidden" id="plan_value" value="" />
    </div>
    <input data-automation-id="companyName" />
    <input data-automation-id="phoneNumber" />
    <button data-automation-id="continueButton" disabled aria-disabled="true">Continue</button>
  `;

  const optionEl = document.querySelector("li#planOptionPro") as unknown as HappyDomElement;
  const triggerEl = document.querySelector("div#planTrigger") as unknown as HappyDomElement;
  const hiddenValueInput = document.getElementById("plan_value") as unknown as { value: string };
  const continueEl = document.querySelector(
    "button[data-automation-id=continueButton]"
  ) as unknown as HappyDomElement;

  // The widget's own selection-commit handler: sets the REAL hidden
  // committed-value control and reflows the visible trigger label — but
  // never touches the option's own tracked fingerprint fields, so credit
  // can only come from the widened sibling read-back, never from the
  // (untracked) visible-label mutation.
  const commitHandlerCalls = { n: 0 };
  (
    optionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    commitHandlerCalls.n += 1;
    hiddenValueInput.value = "pro";
    (triggerEl as unknown as { textContent: string }).textContent = "Pro Plan";
  });

  // happy-dom implements neither `XPathResult` nor `document.evaluate` —
  // polyfill only that, resolving by walking the REAL DOM tree by
  // tag+position, exactly like `flow-runner.list-select-real-actuation.test.ts`.
  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  return { window, optionEl, triggerEl, hiddenValueInput, continueEl, commitHandlerCalls };
}

describe("flow-runner frame-scoped combobox commit + disabled-submit veto (offline fixture, live happy-dom, no network)", () => {
  it("credits the frame-scoped combobox option only via the widened hidden-sibling commit detection, never credits the frame-scoped disabled 'Continue' click, and never reaches downstream progress", async () => {
    const { window, optionEl, triggerEl, hiddenValueInput, continueEl, commitHandlerCalls } =
      buildChildDocument();
    const document = window.document;

    const state: FrameWidgetState = {
      childUrl: CHILD_SRC,
      planOptionClickCount: 0,
      continueClickCount: 0,
      uploadDocsStepReached: false,
    };

    const optionXPath = absoluteXPathFor(optionEl);
    const continueXPath = absoluteXPathFor(continueEl);

    // Every production `page.evaluate`/`frame.evaluate` expression (the
    // iframe-src probe, the frame's own selection baseline map, the
    // ancestor/sibling read-backs, the disabled-target veto, the DOM
    // snapshot) is executed FOR REAL against the live child document via
    // `window.Function` — the fixture never hand-simulates any of
    // `flow-runner.ts`'s internal verification logic.
    const childFrame = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        if (src === "location.href") return state.childUrl;
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, (window as unknown as { XPathResult: unknown }).XPathResult);
      },
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
    };

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      // Only the top-level `<iframe>`-src probe `resolveFrameTarget` issues
      // reaches this — every step-body evaluate goes through the resolved
      // child `FrameTarget` instead.
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(src);
        if (iframeSrcMatch) {
          const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
          return selector === IFRAME_SELECTOR
            ? { matched: true, src: CHILD_SRC }
            : { matched: false, src: null };
        }
        return null;
      },
      url: () => TOP_ORIGIN,
      title: async () => "Billing | Checkout",
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
      frames: () => [childFrame],
    } as unknown as Page;

    const stagehand: Stagehand = {
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const description = describeActInput(input);
        if (description.includes("Full Name")) {
          state.childUrl = `${CHILD_SRC}#name-filled`;
          return {
            success: true,
            message: "filled",
            actionDescription: NAME_STEP,
            actions: [
              {
                selector: "css=[data-automation-id=fullName]",
                description: "Full Name",
                method: "fill",
                arguments: ["Jordan Alvarez"],
              },
            ],
          };
        }
        if (description.includes("Pro Plan")) {
          state.planOptionClickCount += 1;
          return {
            success: true,
            message: "clicked",
            actionDescription: PLAN_OPTION_STEP,
            actions: [
              {
                selector: `xpath=${optionXPath}`,
                description: "Pro Plan option",
                method: "click",
              },
            ],
          };
        }
        if (description.includes("Company Name")) {
          state.childUrl = `${CHILD_SRC}#name-filled-company-filled`;
          return {
            success: true,
            message: "filled",
            actionDescription: COMPANY_STEP,
            actions: [
              {
                selector: "css=[data-automation-id=companyName]",
                description: "Company Name",
                method: "fill",
                arguments: ["Acme Corp"],
              },
            ],
          };
        }
        if (description.includes("Continue")) {
          state.continueClickCount += 1;
          // No URL/network change — the button is disabled, so the resolved
          // click genuinely does nothing observable.
          return {
            success: true,
            message: "clicked",
            actionDescription: CONTINUE_STEP,
            actions: [
              {
                selector: `xpath=${continueXPath}`,
                description: "Continue",
                method: "click",
              },
            ],
          };
        }
        if (description.includes("Upload Documents")) {
          state.uploadDocsStepReached = true;
          state.childUrl = `${CHILD_SRC}#documents-uploaded`;
          return {
            success: true,
            message: "clicked",
            actionDescription: UPLOAD_DOCS_STEP,
            actions: [
              {
                selector: "css=[data-automation-id=uploadDocuments]",
                description: "Upload Documents",
                method: "click",
              },
            ],
          };
        }
        return {
          success: false,
          message: "no actionable candidate",
          actionDescription: description,
          actions: [],
        };
      }),
      // Focused (instruction-scoped) observe stays blind — every step
      // verifies via act()'s own reported action. Unfocused observe returns
      // a stub "page has content" candidate so the reachability fallback
      // hands off to the cascade instead of short-circuiting to "absent".
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    const CHECKOUT_STEPS: HealingFlowStep[] = [
      { instruction: NAME_STEP, optional: false, upload: false, submitStep: false },
      { instruction: PLAN_OPTION_STEP, optional: false, upload: false, submitStep: false },
      { instruction: COMPANY_STEP, optional: false, upload: false, submitStep: false },
      { instruction: CONTINUE_STEP, optional: false, upload: false, submitStep: false },
      { instruction: UPLOAD_DOCS_STEP, optional: false, upload: false, submitStep: false },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: CHECKOUT_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: IFRAME_SELECTOR,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // 'Full Name' and 'Company Name' both ran (and were credited) before the
    // blocked step, proving the failure is attributable to 'Continue', not
    // an earlier setup failure — and that the frame-scoped fill path stays
    // unaffected by the click-path fix under test.
    expect(state.childUrl).toBe(`${CHILD_SRC}#name-filled-company-filled`);

    // The plan option WAS clicked (inside the frame) and its real commit
    // handler fired exactly once — the hidden committed-value control
    // changed, and the visible label reflowed — proving the flow correctly
    // advanced past that step via the widened commit detection scoped to
    // the child frame's own document, not by skipping verification.
    expect(state.planOptionClickCount).toBeGreaterThan(0);
    expect(commitHandlerCalls.n).toBe(1);
    expect(hiddenValueInput.value).toBe("pro");
    expect((triggerEl as unknown as { textContent: string }).textContent).toBe("Pro Plan");

    // The disabled 'Continue' click (inside the frame) was attempted
    // (Stagehand reported success) but NEVER credited: the flow never
    // advanced past it into the step standing in for downstream progress,
    // and the child frame's URL never moved again after the company-name fill.
    expect(state.continueClickCount).toBeGreaterThan(0);
    expect(state.uploadDocsStepReached).toBe(false);
    expect(state.childUrl).toBe(`${CHILD_SRC}#name-filled-company-filled`);
  });
});
