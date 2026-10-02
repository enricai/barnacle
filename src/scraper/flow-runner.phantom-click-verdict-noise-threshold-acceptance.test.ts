import type { Action } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { snapshotPage, verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { classifyPhantomClick } from "@/scraper/phantom-click";

/**
 * Acceptance test for the live `elementStateChanged`/`domVerified` input that
 * feeds `classifyPhantomClick` at flow-runner.ts's click branch
 * (`record.phantomClickVerdict = classifyPhantomClick({ ..., elementStateChanged:
 * domVerified, ... })`) — not the already-correct, already-pinned
 * `phantom-click.test.ts` threshold math. Chains the REAL production
 * `snapshotPage` + `verifyDomEffect` + `classifyPhantomClick` exactly as the
 * flow-runner cascade does, against a live happy-dom document.
 *
 * Reproduces a generic page with TWO INDEPENDENT toggle-shaped widgets (each
 * its own `role="combobox"` trigger + hidden committed-value `<input>`),
 * where the resolved click lands on a third, unrelated decoy control that
 * does nothing — while, concurrently and for a reason entirely unrelated to
 * the click, the SECOND widget's own hidden committed-value control changes.
 * Before the fix, `selectionSiblingCommittedValueChanged`'s shared-ancestor
 * climb (`NEARBY_SELECTION_CONTAINER_FN_SRC`) found the lowest ancestor whose
 * subtree contained ANY marker — here, the shared `.page` wrapper containing
 * BOTH widgets' triggers — and then diffed EVERY `input`/`select` inside that
 * whole wrapper against the baseline, crediting the click off the SECOND
 * (unrelated) widget's own value change even though the resolved/clicked
 * element's own widget never moved. With unchanged networkCount and only a
 * noise-level (attribute-only) HTML byte delta, that false "effective" dom
 * signal is exactly the shape that lifts a no-op click to an "effective"
 * phantom-click verdict instead of "phantom".
 *
 * The second case re-asserts the still-legitimate path this fix must not
 * touch: clicking a toggle whose OWN nearby (unambiguous, single-widget)
 * wrapper commits its own hidden value still classifies "effective", proving
 * the existing design-system-toggle credit path (and the 1.12.54/bugfix-001
 * ancestor-climb widening it builds on) is untouched.
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
 * A page with a no-op decoy button and TWO independent toggle widgets, each
 * a `role="combobox"` trigger paired with its own hidden committed-value
 * `<input>`, all three as cousin branches under one shared `.page` wrapper.
 * The decoy has no marker anywhere in its own branch, so resolving its click
 * forces `selectionSiblingCommittedValueChanged`'s ancestor climb all the way
 * up to `.page` — the first (and only, within depth) ancestor whose subtree
 * contains any marker at all, and the one whose subtree contains BOTH
 * widgets' triggers.
 */
function buildTwoIndependentToggles(): {
  window: Window;
  decoyEl: HappyDomElement;
  toggleATriggerEl: HappyDomElement;
  toggleAValueInput: { value: string };
  toggleBValueInput: { value: string };
} {
  const window = new Window({ url: "https://widgets.example.com/panel" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="page">
      <div class="decoyRow">
        <button id="decoyBtn">Dismiss</button>
      </div>
      <div class="toggleRowA">
        <button role="combobox" aria-expanded="false" id="toggleATrigger">Toggle A</button>
        <input type="hidden" id="toggleAValue" value="" />
      </div>
      <div class="toggleRowB">
        <button role="combobox" aria-expanded="false" id="toggleBTrigger">Toggle B</button>
        <input type="hidden" id="toggleBValue" value="" />
      </div>
    </div>
  `;
  const decoyEl = document.getElementById("decoyBtn") as unknown as HappyDomElement;
  const toggleATriggerEl = document.getElementById("toggleATrigger") as unknown as HappyDomElement;
  const toggleAValueInput = document.getElementById("toggleAValue") as unknown as {
    value: string;
  };
  const toggleBValueInput = document.getElementById("toggleBValue") as unknown as {
    value: string;
  };

  return { window, decoyEl, toggleATriggerEl, toggleAValueInput, toggleBValueInput };
}

/** Wires the real generated expression strings (SELECTION_STATE_MAP_EXPR, verifyDomEffect's click-branch probes) against a live happy-dom document. */
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
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    })) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://widgets.example.com/panel"),
    title: () => Promise.resolve("Panel"),
  };
}

describe("flow-runner phantom-click verdict noise-threshold acceptance (offline fixture, live happy-dom, no network)", () => {
  it("classifies 'phantom' for a no-op decoy click, NOT crediting an UNRELATED sibling toggle's own state change (false-positive ambiguous-container shape)", async () => {
    const { window, decoyEl, toggleBValueInput } = buildTwoIndependentToggles();
    const target = makeTarget(window);
    const signalCounter = { n: 0 };

    const pre = await snapshotPage(target, signalCounter, undefined, true);

    // The decoy's own click does nothing — but, concurrently and for a
    // reason entirely unrelated to this click (e.g. an unrelated async
    // process on the page), Toggle B's own hidden committed-value control
    // changes. This is the report's exact false-positive shape: unchanged
    // networkCount, noise-level (attribute-only) html delta, and a
    // selection-marker flip that does NOT belong to the clicked element.
    toggleBValueInput.value = "unrelated-change";

    const clickAction: Action = {
      selector: `xpath=${absoluteXPathFor(decoyEl)}`,
      description: "Dismiss decoy control",
      method: "click",
    } as Action;

    const domVerified = await verifyDomEffect(target, clickAction, pre.selectionStateByXpath);
    expect(domVerified).toBe(false);

    const post = await snapshotPage(target, signalCounter, undefined, false);
    const verdict = classifyPhantomClick({
      actResultSuccess: true,
      pre: { networkCount: pre.networkCount, url: pre.url, bodyHtmlLength: pre.bodyHtmlLength },
      post: { networkCount: post.networkCount, url: post.url, bodyHtmlLength: post.bodyHtmlLength },
      elementStateChanged: domVerified,
      isSubmitShapedStep: false,
    });
    expect(verdict).toBe("phantom");
  });

  it("classifies 'effective' for a genuine design-system toggle whose OWN nearby committed-value control changes (regression guard, 1.12.54/bugfix-001 path untouched)", async () => {
    const { window, toggleATriggerEl, toggleAValueInput, toggleBValueInput } =
      buildTwoIndependentToggles();
    const target = makeTarget(window);
    const signalCounter = { n: 0 };

    const pre = await snapshotPage(target, signalCounter, undefined, true);

    // Toggle A's own click-commit handler: flips its OWN hidden committed
    // value, same as any real design-system combobox. Toggle B's value is
    // left untouched, proving the credit comes from Toggle A's own widget,
    // not a page-wide scan.
    toggleAValueInput.value = "selected";

    const clickAction: Action = {
      selector: `xpath=${absoluteXPathFor(toggleATriggerEl)}`,
      description: "Toggle A control",
      method: "click",
    } as Action;

    const domVerified = await verifyDomEffect(target, clickAction, pre.selectionStateByXpath);
    expect(domVerified).toBe(true);
    expect(toggleBValueInput.value).toBe("");

    const post = await snapshotPage(target, signalCounter, undefined, false);
    const verdict = classifyPhantomClick({
      actResultSuccess: true,
      pre: { networkCount: pre.networkCount, url: pre.url, bodyHtmlLength: pre.bodyHtmlLength },
      post: { networkCount: post.networkCount, url: post.url, bodyHtmlLength: post.bodyHtmlLength },
      elementStateChanged: domVerified,
      isSubmitShapedStep: false,
    });
    expect(verdict).toBe("effective");
  });
});
