import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Combined regression for bugfix-001 (the sibling committed-value read-back)
 * and bugfix-002 (gating the n+16 fallback's weak html/text/form-value
 * signals off a selection-marker click target). Reproduces the exact recon
 * shape: a generic combobox option click that only re-renders the visible
 * trigger label — `#selectedCountryCode` (the hidden committed control)
 * staying empty while the label reads "(+1) United States" — must NOT be
 * scored verified even though it grows/changes the page text; the SAME click
 * must be verified once the hidden committed control's own value actually
 * changes. Runs the real generated expression strings against a live
 * happy-dom document (real `querySelectorAll`/`closest`), not a mocked
 * `evaluate()` return, per `flow-runner.n16-checkbox-xpath-retarget.test.ts`'s
 * stated rationale.
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
 * Builds a generic country combobox: a `.ComboboxContainer` wrapping a
 * visible trigger `<span>` label, a `role="listbox"` with one option, and a
 * hidden associated `<input id="selectedCountryCode">` the real recon report
 * named. `commitsHiddenValue` controls whether the option's click handler
 * (standing in for the site's own selection-commit code) writes the hidden
 * control's value, or only mutates the visible label — the exact distinction
 * bugfix-001/002 must tell apart.
 */
function buildCombobox(commitsHiddenValue: boolean): {
  window: Window;
  optionEl: HappyDomElement;
  hiddenInput: { value: string };
  label: { textContent: string };
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="ComboboxContainer" role="combobox">
      <span class="TriggerLabel">Country code</span>
      <div role="listbox">
        <li role="option" data-value="us">(+1) United States</li>
      </div>
      <input type="hidden" id="selectedCountryCode" value="" />
    </div>
  `;
  const optionEl = document.querySelector("li[role='option']") as unknown as HappyDomElement;
  const hiddenInput = document.getElementById("selectedCountryCode") as unknown as {
    value: string;
  };
  const label = document.querySelector(".TriggerLabel") as unknown as { textContent: string };

  (
    optionEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Every real widget re-renders the visible trigger label on selection —
    // that alone is what the reported false positive rode past.
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
    url: () => Promise.resolve("https://careers.example.com/apply/job/1"),
    title: () => Promise.resolve("Apply"),
  };
}

function baseParams(page: Page, target: FrameTarget): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step: "Select 'United States' from the country code combobox",
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

describe("flow-runner/executeStepWithHealing — select-from-list click verifies against the committed control, not the label", () => {
  it("does NOT verify a click that only changes the visible trigger label, leaving the hidden committed control unchanged", async () => {
    const { window, optionEl, hiddenInput, label } = buildCombobox(false);
    const target = makeTarget(window, optionEl);
    const page = fakePage();

    await expect(executeStepWithHealing(baseParams(page, target))).rejects.toThrow(
      StepVerificationError
    );

    // The label DID change (the exact false-positive shape the recon report
    // captured) but the hidden committed control never did — must not verify.
    expect(label.textContent).toBe("(+1) United States");
    expect(hiddenInput.value).toBe("");

    const n16Logs = (testLogger.info as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("n+16 probe"));
    expect(n16Logs.length).toBeGreaterThan(0);
    for (const line of n16Logs) {
      expect(line).toContain("verified=false");
    }
  });

  it("verifies the same click once the hidden committed control's value actually changes", async () => {
    const { window, optionEl, hiddenInput, label } = buildCombobox(true);
    const target = makeTarget(window, optionEl);
    const page = fakePage();

    const outcome = await executeStepWithHealing(baseParams(page, target));

    expect(outcome).toBe("completed");
    expect(label.textContent).toBe("(+1) United States");
    expect(hiddenInput.value).toBe("us");
  });
});
