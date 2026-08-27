import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for the widget shape SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC's
 * whole-token vocabulary cannot see: a trigger carrying `role="combobox"`
 * (no `role="option"`/`role="listbox"` anywhere in the list), whose option
 * `<li>` elements carry no ARIA role/state and only a hyphen-compound class
 * (`result-selectable`) that never flips to a bare `selected` token, with the
 * real committed value living on a hidden sibling `<input>`. Verification
 * must key off that hidden control's value, not the visible trigger label.
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
    url: () => "https://picker.example.com/search",
    title: vi.fn().mockResolvedValue("Search"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * A generic result picker: the trigger carries `role="combobox"`, but the
 * option `<li>` elements carry no ARIA role/state at all, only a
 * hyphen-compound `result-selectable` class that never gains a bare
 * `selected` token. The real committed value lives on a hidden sibling
 * `<input>`. `commitsHiddenValue` controls whether the click's handler
 * writes that hidden control (a working handler) or only re-renders the
 * visible trigger label (a broken handler masquerading as success).
 */
function buildComboboxResultPicker(commitsHiddenValue: boolean): {
  window: Window;
  optionEl: HappyDomElement;
  hiddenInput: { value: string };
  label: { textContent: string };
} {
  const window = new Window({ url: "https://picker.example.com/search" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="ResultPicker">
      <button role="combobox" aria-haspopup="listbox" class="trigger">
        <span class="trigger-label">Select a result</span>
      </button>
      <ul class="ResultList">
        <li class="result-item result-selectable" data-value="acme">Acme Corp</li>
        <li class="result-item result-selectable" data-value="globex">Globex Inc</li>
      </ul>
      <input type="hidden" id="selectedResult" value="" />
    </div>
  `;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    (el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({
      width: 10,
      height: 10,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10,
      bottom: 10,
    });
  }

  const optionEl = document.querySelector("li[data-value='globex']") as unknown as HappyDomElement;
  const hiddenInput = document.getElementById("selectedResult") as unknown as { value: string };
  const label = document.querySelector(".trigger-label") as unknown as { textContent: string };

  (
    optionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    label.textContent = "Globex Inc";
    if (commitsHiddenValue) hiddenInput.value = "globex";
  });

  return { window, optionEl, hiddenInput, label };
}

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
    { selector, description: "Globex Inc result", method: "click" },
  ]);
  guardedAct.mockResolvedValue({
    success: true,
    message: "clicked",
    actionDescription: "Globex Inc result",
    actions: [{ selector, description: "Globex Inc result", method: "click" }],
  });

  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: vi.fn() as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://picker.example.com/search"),
    title: () => Promise.resolve("Search"),
  };
}

function baseParams(page: Page, target: FrameTarget): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step: "Select 'Globex Inc' from the result list",
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

describe("flow-runner/executeStepWithHealing — role=combobox trigger with classless hyphen-compound options", () => {
  it("verifies the click against the hidden committed control once it actually receives the selected value", async () => {
    const { window, optionEl, hiddenInput, label } = buildComboboxResultPicker(true);
    const target = makeTarget(window, optionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("Globex Inc");
    expect(hiddenInput.value).toBe("globex");
  });

  it("does NOT verify a click that only re-renders the visible trigger label, leaving the hidden committed control empty", async () => {
    const { window, optionEl, hiddenInput, label } = buildComboboxResultPicker(false);
    const target = makeTarget(window, optionEl);
    const page = fakePage();

    await expect(executeStepWithHealing(baseParams(page, target))).rejects.toThrow(
      StepVerificationError
    );

    expect(label.textContent).toBe("Globex Inc");
    expect(hiddenInput.value).toBe("");
  });
});
