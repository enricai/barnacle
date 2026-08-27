import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-001's class-token-only gap: a `<li class="dropdown-
 * option">` option with no role/aria/data-state and no hidden sibling
 * input, whose sole selection signal is the same `selected` class token the
 * shared marker vocabulary recognizes — but whose click handler is broken
 * and never adds that token. The label still re-renders, so the weak
 * html/text OR-branch would credit the click unless `clickTargetHasSelection
 * Marker` recognizes the clicked leaf as a member of the class-token
 * selection group via its untouched, still-`selected` sibling. Mirrors
 * `flow-runner.select-from-list-committed-control.test.ts`'s happy-dom
 * harness (real generated expression strings, not a mocked `evaluate()`).
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
    url: () => "https://careers.example.com/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * Builds a custom dropdown with NO role/aria/data-state markers at all — the
 * only selection signal anywhere is the `selected` class token. A default
 * option ("Canada") already carries it. `commitsSelection` controls whether
 * clicking "United States" moves the token (a working handler) or only
 * re-renders the visible trigger label, leaving "Canada" still `selected`
 * (a broken handler) — the exact distinction the fix must tell apart.
 */
function buildClassTokenDropdown(commitsSelection: boolean): {
  window: Window;
  targetOptionEl: HappyDomElement;
  usOptionEl: { className: string };
  caOptionEl: { className: string };
  label: { textContent: string };
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="ComboboxContainer">
      <span class="TriggerLabel">Canada</span>
      <ul class="OptionList">
        <li class="dropdown-option selected" data-value="ca">Canada</li>
        <li class="dropdown-option" data-value="us">(+1) United States</li>
      </ul>
    </div>
  `;
  // happy-dom has no real layout engine — every element's real
  // `getBoundingClientRect()` is a zero rect, which would make
  // `SELECTION_STATE_MAP_EXPR`'s `visible()` gate exclude every `<li>` from
  // the pre-click baseline regardless of this fix. Stub a non-zero rect so
  // the baseline capture (a REAL production concern this harness must not
  // mask) behaves as it would against an actually-rendered page.
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

  const usOptionEl = document.querySelector("li[data-value='us']") as unknown as HappyDomElement & {
    className: string;
  };
  const caOptionEl = document.querySelector("li[data-value='ca']") as unknown as HappyDomElement & {
    className: string;
  };
  const label = document.querySelector(".TriggerLabel") as unknown as { textContent: string };

  (
    usOptionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Every real widget re-renders the visible trigger label on selection —
    // that alone is what the reported false positive rode past.
    label.textContent = "(+1) United States";
    if (commitsSelection) {
      caOptionEl.className = "dropdown-option";
      usOptionEl.className = "dropdown-option selected";
    }
  });

  return { window, targetOptionEl: usOptionEl, usOptionEl, caOptionEl, label };
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
    url: () => Promise.resolve("https://careers.example.com/apply/job/1"),
    title: () => Promise.resolve("Apply"),
  };
}

function baseParams(page: Page, target: FrameTarget): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step: "Select 'United States' from the country code dropdown",
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

describe("flow-runner/executeStepWithHealing — class-token-only selection marker (no role/aria/data-state)", () => {
  it("does NOT verify a click that only changes the visible trigger label, leaving the class-token marker on the untouched prior selection", async () => {
    const { window, targetOptionEl, caOptionEl, label } = buildClassTokenDropdown(false);
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    await expect(executeStepWithHealing(baseParams(page, target))).rejects.toThrow(
      StepVerificationError
    );

    // The label DID change (the exact false-positive shape) but the class
    // token never moved off the untouched prior selection — must not verify.
    expect(label.textContent).toBe("(+1) United States");
    expect(caOptionEl.className).toBe("dropdown-option selected");
  });

  it("verifies the same click once the class token actually moves to the clicked option", async () => {
    const { window, targetOptionEl, usOptionEl, caOptionEl, label } = buildClassTokenDropdown(true);
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("(+1) United States");
    expect(usOptionEl.className).toBe("dropdown-option selected");
    expect(caOptionEl.className).toBe("dropdown-option");
  });
});
