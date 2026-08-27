import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-001's widened `selectionSiblingCommittedValueChanged`
 * ancestor climb. Reproduces a generic checkout country-code picker whose
 * trigger (`role="combobox"`), option list, and hidden committed `<input>`
 * are cousins several levels under a bare, unmarked wrapper `<div>` — no
 * `[role=combobox]`/`[role=listbox]`/`[class*=Container]`/`[class*=Group]`
 * marker sits on any node between the clicked option and that wrapper. The
 * old single-hop `closest()` search only walks self-and-ancestors of the
 * clicked option, so it could never see the trigger's marker on the sibling
 * branch and fell back to the option's immediate parent — which does not
 * contain the hidden input — so the baseline capture skipped the hidden
 * input entirely and its value change was never credited. The widened
 * bounded ancestor climb (`NEARBY_SELECTION_CONTAINER_FN_SRC`) searches each
 * ancestor's WHOLE subtree for a marker, finding the common wrapper several
 * levels up and crediting the click once the hidden control's value changes.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

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

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function fakePage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => "https://checkout.example.com/shipping",
    title: vi.fn().mockResolvedValue("Checkout"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * Builds a generic checkout country-code picker: a bare, unmarked
 * `.picker-root` > `.picker-inner` wrapper containing three cousin
 * branches — a `.trigger-wrap` holding the `role="combobox"` trigger, a
 * `.list-wrap` > `.list-inner` holding the `role="option"` list (no
 * `role="listbox"` anywhere, so the old fallback `closest('[role="listbox"]')`
 * cannot rescue it either), and a `.hidden-wrap` holding the hidden
 * committed-value `<input>`. None of `.picker-root`, `.picker-inner`,
 * `.trigger-wrap`, `.list-wrap`, `.list-inner`, or `.hidden-wrap` carry a
 * `role`/`class*=Container`/`class*=Group` marker — the marker lives ONLY on
 * the trigger, three levels below `.picker-inner` on a sibling branch of
 * both the option and the hidden input.
 */
function buildCountryPicker(commitsHiddenValue: boolean): {
  window: Window;
  optionEl: HappyDomElement;
  hiddenInput: { value: string };
  label: { textContent: string };
} {
  const window = new Window({ url: "https://checkout.example.com/shipping" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="picker-root">
      <div class="picker-inner">
        <div class="trigger-wrap">
          <button role="combobox" aria-haspopup="listbox" class="trigger">
            <span class="trigger-label">Country code</span>
          </button>
        </div>
        <div class="list-wrap">
          <div class="list-inner">
            <ul>
              <li role="option" data-value="us">(+1) United States</li>
            </ul>
          </div>
        </div>
        <div class="hidden-wrap">
          <input type="hidden" id="selectedCountryCode" value="" />
        </div>
      </div>
    </div>
  `;
  const optionEl = document.querySelector("li[role='option']") as unknown as HappyDomElement;
  const hiddenInput = document.getElementById("selectedCountryCode") as unknown as {
    value: string;
  };
  const label = document.querySelector(".trigger-label") as unknown as { textContent: string };

  (
    optionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Every real widget re-renders the visible trigger label on selection.
    label.textContent = "(+1) United States";
    if (commitsHiddenValue) hiddenInput.value = "us";
  });

  return { window, optionEl, hiddenInput, label };
}

/** Wires the real generated expression strings against a live happy-dom document. */
function makeTarget(window: Window, optionEl: HappyDomElement): FrameTarget {
  const document = window.document;
  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const evaluate = (async (expr: unknown): Promise<unknown> => {
    const src = String(expr);
    const fn = new window.Function("document", `return (${src});`) as (d: unknown) => unknown;
    return fn(document);
  }) as FrameTarget["evaluate"];

  const xpath = absoluteXPathFor(optionEl);
  const selector = `xpath=${xpath}`;

  guardedObserve.mockResolvedValue([
    { selector, description: "(+1) United States option", method: "click" },
  ]);
  guardedAct.mockResolvedValue({
    success: true,
    message: "clicked",
    actionDescription: "(+1) United States option",
    actions: [{ selector, description: "(+1) United States option", method: "click" }],
  });

  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: vi.fn() as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://checkout.example.com/shipping"),
    title: () => Promise.resolve("Checkout"),
  };
}

function baseParams(page: Page, target: FrameTarget): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step: "Select 'United States' from the country code picker",
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
    frameTarget: target,
  } as never;
}

describe("flow-runner/executeStepWithHealing — dropdown hidden sibling commit outside any role/class-marked ancestor", () => {
  it("credits the option click once the hidden committed control several ancestor levels up changes value, with no marker on any intermediate node", async () => {
    const { window, optionEl, hiddenInput, label } = buildCountryPicker(true);
    const target = makeTarget(window, optionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("(+1) United States");
    expect(hiddenInput.value).toBe("us");
  });
});
