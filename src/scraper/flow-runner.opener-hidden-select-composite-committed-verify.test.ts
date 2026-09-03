import type { Action } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Regression for the `selectOption`/`selectOptionFromDropdown` branch of
 * `verifyDomEffect`: a composite opener+hidden-`<select>` widget with
 * `role="combobox"` on the SHARED container (not a descendant) resolves,
 * from the hidden select's own xpath, to no `[role="combobox"]` descendant —
 * the prior code then fell back to reading the RESOLVED ELEMENT's (the
 * select's) raw `textContent`, which concatenates EVERY `<option>`'s text
 * and so "matches" the requested option whether or not it was actually
 * selected. The fix reads only the committed signal — the
 * `aria-activedescendant`-referenced node, the select's own
 * `selectedIndex` option, or the opener's own text with any nested
 * select/listbox stripped — never the raw concatenated text.
 */

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

/**
 * `role="combobox"` on the SHARED CONTAINER itself, not on a descendant —
 * the exact shape that makes `container.querySelector('[role="combobox"]')`
 * return null (querySelector never matches the calling element) and, pre-fix,
 * fell through to reading the resolved select's own raw `textContent`.
 */
function buildWidget(params: { committed: boolean }): {
  window: Window;
  hiddenSelect: HappyDomElement;
} {
  const window = new Window({ url: "https://apply.example.com/onboard/a/1" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="widget-container" role="combobox"${params.committed ? ' aria-activedescendant="opt-us"' : ""}>
      <span class="opener-label">Choose a country</span>
      <select class="hidden-shadow-select">
        <option value="">Select</option>
        <option id="opt-us" value="us"${params.committed ? " selected" : ""}>United States</option>
        <option value="ca">Canada</option>
      </select>
    </div>
  `;
  const hiddenSelect = document.querySelector(
    "select.hidden-shadow-select"
  ) as unknown as HappyDomElement;
  if (params.committed) {
    (hiddenSelect as unknown as { value: string; selectedIndex: number }).value = "us";
    (hiddenSelect as unknown as { value: string; selectedIndex: number }).selectedIndex = 1;
  }
  return { window, hiddenSelect };
}

/** Wires the real generated expression string against a live happy-dom document. */
function makeTarget(window: Window): FrameTarget {
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

  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: (() => ({
      first: () => ({
        isChecked: async (): Promise<boolean> => false,
        inputValue: async (): Promise<string> => "",
      }),
    })) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://apply.example.com/onboard/a/1"),
    title: () => Promise.resolve("Onboard"),
  };
}

function selectAction(xpath: string): Action {
  return {
    selector: `xpath=${xpath}`,
    description: "country select",
    method: "selectOptionFromDropdown",
    arguments: ["United States"],
  } as Action;
}

describe("flow-runner/verifyDomEffect — composite opener+hidden-select selectOption verification", () => {
  it("verifies via the opener's own committed signal (aria-activedescendant + the select's own selectedIndex option), not raw concatenated text", async () => {
    const { window, hiddenSelect } = buildWidget({ committed: true });
    const target = makeTarget(window);
    const xpath = absoluteXPathFor(hiddenSelect);

    const preValue = (hiddenSelect as unknown as { value: string }).value;
    const preSelectedIndex = (hiddenSelect as unknown as { selectedIndex: number }).selectedIndex;

    const result = await verifyDomEffect(target, selectAction(xpath));

    expect(result).toBe(true);
    // No test-observable write against the hidden select's own committed
    // state occurred as a side effect of verification.
    expect((hiddenSelect as unknown as { value: string }).value).toBe(preValue);
    expect((hiddenSelect as unknown as { selectedIndex: number }).selectedIndex).toBe(
      preSelectedIndex
    );
  });

  it("does NOT verify merely because the target option's text exists SOMEWHERE in the hidden select's option list — nothing was actually committed", async () => {
    const { window, hiddenSelect } = buildWidget({ committed: false });
    const target = makeTarget(window);
    const xpath = absoluteXPathFor(hiddenSelect);

    const preValue = (hiddenSelect as unknown as { value: string }).value;
    const preSelectedIndex = (hiddenSelect as unknown as { selectedIndex: number }).selectedIndex;

    // Sanity: the report's false-positive/false-negative failure mode — the
    // raw (uncommitted) select's overall textContent DOES contain the target
    // substring, purely because "United States" is one of its options.
    const rawTextContent = (
      hiddenSelect as unknown as { textContent: string }
    ).textContent.toLowerCase();
    expect(rawTextContent).toContain("united states");

    const result = await verifyDomEffect(target, selectAction(xpath));

    expect(result).toBe(false);
    expect((hiddenSelect as unknown as { value: string }).value).toBe(preValue);
    expect((hiddenSelect as unknown as { selectedIndex: number }).selectedIndex).toBe(
      preSelectedIndex
    );
  });
});
