import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline end-to-end acceptance regression combining both defects from the
 * recon report in one generic (non-site) flow: fill a required field, open a
 * custom combobox and click an option whose actuation ONLY reflows the
 * visible trigger label (never the option's own ARIA/class/data-state, and
 * never a network/URL change), then click a "Continue" control that stays
 * disabled/`aria-disabled` because a SEPARATE required field ('Phone
 * Number') was never filled.
 *
 * Runs the real production expressions (`SELECTION_STATE_MAP_EXPR`,
 * `selectionAncestorChanged`, `selectionSiblingCommittedValueChanged`,
 * `DISABLED_MARKER_EL_EXPR`) against a live happy-dom document via
 * `window.Function`, mirroring `flow-runner.list-select-real-actuation.test.ts`,
 * so no internal helper needs to be hand-simulated by the fixture — only the
 * DOM shape and the option's own commit handler are authored here.
 *
 * Two assertions, both required by the recon report's step-7 repro:
 *   1. The option click is credited ONLY via the widened ancestor-climb
 *      commit detection (`selectionSiblingCommittedValueChanged`, bugfix-001)
 *      finding the option's REAL hidden committed-value sibling change —
 *      never via the weak, untracked visible-label mutation alone (the
 *      fingerprint diff never inspects `textContent`).
 *   2. The subsequent "Continue" click, which resolves disabled because
 *      'Phone Number' is empty, is vetoed by `clickBlockedByDisabled`
 *      (already existing) and never scored verified — the flow rejects with
 *      `StepVerificationError` and never reaches the step standing in for
 *      downstream progress.
 */

const BASE_URL = "https://example-checkout.example.com/apply/billing";

const NAME_STEP = "Fill in the 'Full Name' field with 'Jordan Alvarez'";
const PLAN_OPTION_STEP = "Click the 'Pro Plan' option in the plan combobox";
/** 'Phone Number' is left empty, so 'Continue' stays disabled/aria-disabled — the report's step-7 shape. */
const CONTINUE_STEP = "Click the 'Continue' button";
/** Stands in for downstream progress — must never run if the disabled 'Continue' click is (correctly) never credited. */
const UPLOAD_DOCS_STEP = "Click the 'Upload Documents' button";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** In-memory model of the checkout page's observable state. */
interface CheckoutSequenceState {
  url: string;
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

describe("flow-runner disabled-submit-blocked-by-uncommitted-selection (offline fixture, live happy-dom, no network)", () => {
  it("credits the combobox option click only via the widened hidden-sibling commit detection, then never credits the disabled 'Continue' click, and never reaches downstream progress", async () => {
    const window = new Window({ url: BASE_URL });
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
      <input data-automation-id="phoneNumber" />
      <button data-automation-id="continueButton" disabled aria-disabled="true">Continue</button>
    `;

    const optionEl = document.querySelector("li#planOptionPro") as unknown as HappyDomElement;
    const triggerEl = document.querySelector("div#planTrigger") as unknown as HappyDomElement;
    const hiddenValueInput = document.getElementById("plan_value") as unknown as { value: string };
    expect(optionEl).not.toBeNull();

    // The site's own selection-commit handler: sets the REAL hidden
    // committed-value control and reflows the visible trigger label — but
    // never touches the option's own tracked fingerprint fields (kind,
    // class, aria-*, data-state, checked, value) nor the trigger's, so the
    // credit can only come from the widened sibling read-back, never from
    // the (untracked) visible-label mutation.
    let commitHandlerCalls = 0;
    (
      optionEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      commitHandlerCalls += 1;
      hiddenValueInput.value = "pro";
      (triggerEl as unknown as { textContent: string }).textContent = "Pro Plan";
    });

    const optionXPath = absoluteXPathFor(optionEl);
    const continueEl = document.querySelector(
      "button[data-automation-id=continueButton]"
    ) as unknown as HappyDomElement;
    const continueXPath = absoluteXPathFor(continueEl);

    const documentElement = document.documentElement as unknown as HappyDomElement;
    // happy-dom implements neither `XPathResult` nor `document.evaluate` — polyfill
    // only that, resolving by walking the REAL DOM tree by tag+position, exactly
    // like `flow-runner.list-select-real-actuation.test.ts`.
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (
      document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }
    ).evaluate = (expr: string) => {
      const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
      return { singleNodeValue: node };
    };

    const state: CheckoutSequenceState = {
      url: BASE_URL,
      planOptionClickCount: 0,
      continueClickCount: 0,
      uploadDocsStepReached: false,
    };

    const session = { on: () => {}, off: () => {} };
    // Every production `page.evaluate` expression (the selection baseline map,
    // the ancestor/sibling read-backs, the disabled-target veto, the DOM
    // snapshot) is executed FOR REAL against the live document via
    // `window.Function` — the fixture never hand-simulates any of
    // `flow-runner.ts`'s internal verification logic.
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function(
          "document",
          "XPathResult",
          `return (${src});`
        ) as (d: unknown, x: unknown) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => state.url,
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
    } as unknown as Page;

    const stagehand: Stagehand = {
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const description = describeActInput(input);
        if (description.includes("Full Name")) {
          state.url = `${BASE_URL}#name-filled`;
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
          state.url = `${BASE_URL}#documents-uploaded`;
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
      // Focused (instruction-scoped) observe stays blind — every step verifies
      // via act()'s own reported action. Unfocused observe returns a stub
      // "page has content" candidate so the reachability fallback hands off
      // to the cascade instead of short-circuiting to "absent".
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
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The 'Full Name' fill ran before the sequence's blocked step, proving
    // the failure is attributable to 'Continue', not an earlier setup
    // failure.
    expect(state.url).toBe(`${BASE_URL}#name-filled`);

    // The plan option WAS clicked and its real commit handler fired — the
    // hidden committed-value control changed, and the visible label
    // reflowed — proving the flow correctly advanced past that step via the
    // widened commit detection, not by skipping verification.
    expect(state.planOptionClickCount).toBeGreaterThan(0);
    expect(commitHandlerCalls).toBe(1);
    expect(hiddenValueInput.value).toBe("pro");
    expect((triggerEl as unknown as { textContent: string }).textContent).toBe("Pro Plan");

    // The disabled 'Continue' click was attempted (Stagehand reported
    // success) but NEVER credited: the flow never advanced past it into the
    // step standing in for downstream progress, and the URL never moved
    // again after the option pick.
    expect(state.continueClickCount).toBeGreaterThan(0);
    expect(state.uploadDocsStepReached).toBe(false);
    expect(state.url).toBe(`${BASE_URL}#name-filled`);
  });
});
