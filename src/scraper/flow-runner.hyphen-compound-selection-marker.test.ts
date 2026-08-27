import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-001: a custom option list authored with a
 * hyphen-compound state token (`result-selectable` flipping to
 * `result-selected` on commit, rather than a bare/kit-prefixed `selected`)
 * never matched the prior whole-token-only vocabulary, so the click's real
 * commit was invisible to `clickTargetHasSelectionMarker` /
 * `selectionAncestorChanged`, and the click fell through to being credited
 * on a bare label re-render (`textChanged=true`) alone. Mirrors
 * `flow-runner.class-token-selection-marker.test.ts`'s harness with a
 * hyphen-compound token instead of a bare one.
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
    url: () => "https://jobs.example.com/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * A custom result-list widget whose sole selection signal is the
 * hyphen-compound `result-selectable`/`result-selected` token pair — no
 * role/aria/data-state marker anywhere. `commitsSelection` controls whether
 * clicking the second result moves the token (a working handler) or only
 * re-renders the visible summary label, leaving the first result still
 * `result-selected` (a broken handler).
 */
function buildHyphenCompoundResultList(commitsSelection: boolean): {
  window: Window;
  targetOptionEl: HappyDomElement;
  firstResultEl: { className: string };
  secondResultEl: { className: string };
  summary: { textContent: string };
} {
  const window = new Window({ url: "https://jobs.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="ResultPicker">
      <span class="SummaryLabel">Acme Corp</span>
      <ul class="ResultList">
        <li class="result-item result-selected" data-value="acme">Acme Corp</li>
        <li class="result-item result-selectable" data-value="globex">Globex Inc</li>
      </ul>
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

  const secondResultEl = document.querySelector(
    "li[data-value='globex']"
  ) as unknown as HappyDomElement & { className: string };
  const firstResultEl = document.querySelector(
    "li[data-value='acme']"
  ) as unknown as HappyDomElement & { className: string };
  const summary = document.querySelector(".SummaryLabel") as unknown as { textContent: string };

  (
    secondResultEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    summary.textContent = "Globex Inc";
    if (commitsSelection) {
      firstResultEl.className = "result-item result-selectable";
      secondResultEl.className = "result-item result-selected";
    }
  });

  return { window, targetOptionEl: secondResultEl, firstResultEl, secondResultEl, summary };
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
    url: () => Promise.resolve("https://jobs.example.com/apply/job/1"),
    title: () => Promise.resolve("Apply"),
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

describe("flow-runner/executeStepWithHealing — hyphen-compound class-token selection marker", () => {
  it("does NOT verify a click that only changes the visible summary label, leaving the hyphen-compound marker on the untouched prior selection", async () => {
    const { window, targetOptionEl, firstResultEl, summary } = buildHyphenCompoundResultList(false);
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    await expect(executeStepWithHealing(baseParams(page, target))).rejects.toThrow(
      StepVerificationError
    );

    expect(summary.textContent).toBe("Globex Inc");
    expect(firstResultEl.className).toBe("result-item result-selected");
  });

  it("verifies the same click once the hyphen-compound token actually moves to the clicked option", async () => {
    const { window, targetOptionEl, firstResultEl, secondResultEl, summary } =
      buildHyphenCompoundResultList(true);
    const target = makeTarget(window, targetOptionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(summary.textContent).toBe("Globex Inc");
    expect(secondResultEl.className).toBe("result-item result-selected");
    expect(firstResultEl.className).toBe("result-item result-selectable");
  });
});
