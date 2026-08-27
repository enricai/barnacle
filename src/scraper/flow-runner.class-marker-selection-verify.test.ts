import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage locking in bugfix-001's class-token-only selection
 * marker widening. Reproduces a generic result-list widget authored with NO
 * `role`/`aria-*`/`data-state` anywhere — every `<li>` is a bare `class="…
 * result-selectable"` node, matching the exact "no ARIA" shape the recon
 * report described. Proves: (a) a click whose handler never lands ANY
 * commit signal (no class-token flip, no hidden sibling value change) stays
 * unverified even though the visible label re-renders (`textChanged=true`);
 * (b) the same click verifies once EITHER the class token flips onto the
 * clicked option OR the hidden sibling control's value changes, without
 * requiring both.
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
    url: () => "https://directory.example.com/results",
    title: vi.fn().mockResolvedValue("Results"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

type CommitShape = "none" | "class-token" | "hidden-sibling";

/**
 * Builds a bare result list whose OPTIONS carry no `role`/`aria-*`/
 * `data-state` — only a class-token. The first `<li>` already carries the
 * `selected` class token (a default prior selection), which is what proves
 * to `clickTargetHasSelectionMarker` that this group uses the class-token
 * convention at all — without it, a click whose handler is entirely broken
 * would look identical to a group that has no selection-state convention to
 * violate, and the "unverified" assertion below would not actually exercise
 * the fix. A `role="combobox"` trigger sits alongside the list purely so
 * `selectionSiblingCommittedValueChanged`'s ancestor climb has a marker to
 * find the shared wrapper by (mirrors every real widget's trigger button) —
 * it is never the clicked target and carries none of the option's own
 * selection state, so it does not undercut the "no ARIA on the option"
 * claim under test.
 */
function buildResultList(commitShape: CommitShape): {
  window: Window;
  targetOptionEl: HappyDomElement;
  label: { textContent: string };
  hiddenInput: { value: string };
} {
  const window = new Window({ url: "https://directory.example.com/results" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="result-picker">
      <button role="combobox" aria-haspopup="listbox" class="trigger">
        <span class="picker-label">Choose a result</span>
      </button>
      <ul class="result-list">
        <li class="result-item result-selectable selected" data-value="acme">Acme Co</li>
        <li class="result-item result-selectable" data-value="globex">Globex Inc</li>
      </ul>
      <input type="hidden" id="selectedResult" value="" />
    </div>
  `;
  // happy-dom has no real layout engine — stub a non-zero rect so the
  // pre-click baseline capture's `visible()` gate does not exclude every
  // `<li>` regardless of this fix (a real production concern, not a mock).
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

  const targetOptionEl = document.querySelector(
    "li[data-value='globex']"
  ) as unknown as HappyDomElement & { className: string };
  const priorOptionEl = document.querySelector(
    "li[data-value='acme']"
  ) as unknown as HappyDomElement & { className: string };
  const label = document.querySelector(".picker-label") as unknown as { textContent: string };
  const hiddenInput = document.getElementById("selectedResult") as unknown as { value: string };

  (
    targetOptionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Every real widget re-renders the visible label on selection — this
    // alone must never be enough to credit the click.
    label.textContent = "Globex Inc";
    if (commitShape === "class-token") {
      priorOptionEl.className = "result-item result-selectable";
      targetOptionEl.className = "result-item result-selectable selected";
    }
    if (commitShape === "hidden-sibling") {
      hiddenInput.value = "globex";
    }
  });

  return { window, targetOptionEl, label, hiddenInput };
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
    url: () => Promise.resolve("https://directory.example.com/results"),
    title: () => Promise.resolve("Results"),
  };
}

function baseParams(page: Page, target: FrameTarget): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step: "Select 'Globex Inc' from the results list",
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

describe("flow-runner/executeStepWithHealing — class-only (no ARIA) selection-list commit verification", () => {
  it("does NOT verify a click whose commit never lands, despite the visible label changing", async () => {
    const { window, targetOptionEl, label, hiddenInput } = buildResultList("none");
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    await expect(executeStepWithHealing(baseParams(page, target))).rejects.toThrow(
      StepVerificationError
    );

    expect(label.textContent).toBe("Globex Inc");
    expect(hiddenInput.value).toBe("");
    expect(targetOptionEl.className).not.toContain("selected");
  });

  it("verifies once the class token flips onto the clicked class-only option", async () => {
    const { window, targetOptionEl, label } = buildResultList("class-token");
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("Globex Inc");
    expect(targetOptionEl.className).toContain("selected");
  });

  it("verifies once the hidden sibling control's value changes, with no class-token flip on the option itself", async () => {
    const { window, targetOptionEl, label, hiddenInput } = buildResultList("hidden-sibling");
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("Globex Inc");
    expect(hiddenInput.value).toBe("globex");
  });
});
