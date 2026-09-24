import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (recon-trusted-click-throw-fallback-hits-wrong-element-
 * credited-as-success.md): the n+16 fallback's `clickExpr` re-anchors onto
 * `xpathTailForRetarget`'s tail xpath when the primary (stale, sibling-
 * position-only) xpath no longer resolves — e.g. an earlier field's blur
 * inserted a validation node as a preceding sibling of an ancestor,
 * shifting every downstream positional index even though the leaf control
 * itself never moved. The submit-shape probe must reflect the node the
 * click ACTUALLY lands on (the tail-resolved one), not a blind primary-
 * xpath-only read that silently returns false exactly when the retarget
 * fires.
 *
 * Both fixtures below stale the primary xpath identically (inserting a
 * decoy sibling ahead of the control's container so the recorded absolute
 * path resolves to an empty decoy subtree, forcing every attempt through
 * the tail-retarget branch) and differ only in whether the tail-resolved
 * control is objectively submit-shaped.
 */

const BASE_URL = "https://apply.example.com/step/1";
const STEP_INSTRUCTION = "Click the button to continue";
const HARMLESS_SECOND_STEP = "Click the 'Details' link";

function makeLogger(): { logger: Logger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn((msg: string) => warn.push(msg)),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info, warn };
}

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

function parseXPathSteps(xp: string): { tag: string; idx: number }[] {
  return xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase() as string, idx: Number(match[2]) };
    });
}

// Mirrors the live-DOM walk resolveAbsoluteXPath uses in the sibling
// submit-shaped-weak-signal-veto fixture — a positional index that no
// longer has a matching child (the decoy subtree is empty) resolves to
// null, exactly like the real stale-primary-xpath failure mode.
function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = parseXPathSteps(xp);
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

// Mirrors xpathTailForRetarget's own re-anchor: matches only the leaf's
// (and, if present, its immediate parent's) tag + same-tag-sibling
// position, ignoring every ancestor above that — the same loose match the
// production tail xpath performs, independent of any ancestor shift.
function resolveTailXPath(root: HappyDomElement, tailXp: string): HappyDomElement | null {
  const steps = parseXPathSteps(tailXp);
  const leafStep = steps[steps.length - 1];
  const parentStep = steps.length > 1 ? steps[steps.length - 2] : null;
  if (!leafStep) return null;
  const all = Array.from(root.querySelectorAll("*")) as HappyDomElement[];
  for (const el of all) {
    if (el.tagName !== leafStep.tag) continue;
    const parent = el.parentElement as HappyDomElement | null;
    if (!parent) continue;
    const sameTagSiblings = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === leafStep.tag
    );
    if (sameTagSiblings.indexOf(el) + 1 !== leafStep.idx) continue;
    if (parentStep) {
      if (parent.tagName !== parentStep.tag) continue;
      const grandparent = parent.parentElement as HappyDomElement | null;
      const parentIdx = grandparent
        ? Array.from(grandparent.children)
            .filter((c: HappyDomElement) => c.tagName === parentStep.tag)
            .indexOf(parent) + 1
        : 1;
      if (parentIdx !== parentStep.idx) continue;
    }
    return el;
  }
  return null;
}

/**
 * Builds the shared offline fixture: a two-step flow whose first step's
 * `el.click()` resolves via the n+16 fallback ONLY through the xpathTail
 * retarget (the recorded primary xpath is deliberately staled by a decoy
 * sibling inserted ahead of the control's container, modeling the
 * ancestor-index-shift xpathTailForRetarget's own docblock describes).
 */
function buildFixture(params: {
  controlTag: string;
  controlAttrs: string;
  wrapInForm: boolean;
  clickHandler: (document: {
    getElementById: (id: string) => HappyDomElement | null;
    createElement: (tag: string) => HappyDomElement;
  }) => void;
}): {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  const formOpenTag = params.wrapInForm ? '<form id="theForm">' : "<div>";
  const formCloseTag = params.wrapInForm ? "</form>" : "</div>";
  document.body.innerHTML = `
    <div class="page">
      <div class="wizardFooter">
        ${formOpenTag}
          <${params.controlTag} id="theControl" ${params.controlAttrs}>Continue</${params.controlTag}>
        ${formCloseTag}
        <a id="detailsLink" href="#details">Details</a>
      </div>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
  if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

  // Capture the "recorded" xpath BEFORE staling it, exactly as Stagehand's
  // act() would have resolved it on the pre-re-render DOM.
  const controlXPath = absoluteXPathFor(controlEl);
  const detailsLinkXPath = absoluteXPathFor(detailsLinkEl);

  // Stale the primary xpath: insert a decoy sibling ahead of `.wizardFooter`
  // so the recorded absolute path now walks into an empty decoy subtree —
  // the leaf control itself never moved, only every ancestor's positional
  // index shifted, exactly xpathTailForRetarget's docblock scenario.
  const pageDiv = document.querySelector(".page") as unknown as HappyDomElement;
  const decoy = document.createElement("div");
  (
    pageDiv as unknown as {
      insertBefore: (n: HappyDomElement, ref: HappyDomElement | null) => void;
    }
  ).insertBefore(decoy, pageDiv.firstElementChild ?? null);

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () =>
    params.clickHandler(
      document as unknown as {
        getElementById: (id: string) => HappyDomElement | null;
        createElement: (tag: string) => HappyDomElement;
      }
    )
  );

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//")
      ? resolveTailXPath(documentElement, expr.slice(2))
      : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => BASE_URL,
    title: async () => "Apply — Step 1",
    // A real Playwright `.locator(xpath)` only resolves the PRIMARY xpath —
    // it has no knowledge of the n+16 fallback's own xpathTail re-anchor —
    // so the trusted-click delivery attempt must fail exactly like it would
    // against a genuinely stale selector, falling through to the synthetic
    // `clickExpr` fallback under test (which performs the tail retarget).
    locator: (selector: unknown) => ({
      first: () => ({
        click: async () => {
          const xp = String(selector).replace(/^xpath=/, "");
          const el = resolveAbsoluteXPath(documentElement, xp);
          if (!el) throw new Error("no node found for selector");
          (el as unknown as { click: () => void }).click();
        },
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
    // Stagehand's own act() never touches the DOM — the recorded selector
    // is the now-stale primary xpath, forcing every attempt through the
    // n+16 fallback's own xpathTail resolution.
    act: vi.fn().mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
    })),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  void detailsLinkXPath;

  const steps: HealingFlowStep[] = [
    { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
    { instruction: HARMLESS_SECOND_STEP, optional: true, upload: false, submitStep: false },
  ];

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, steps, logger, info, warn };
}

describe("flow-runner n+16 fallback — submit-shape probe reflects the xpathTail-retargeted node", () => {
  it("does NOT credit an UNFLAGGED, non-final step on formValueChanged/textChanged/htmlDelta alone when the primary xpath is unresolvable and the click lands, via xpathTail retarget, on a submit-shaped control", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "button",
      controlAttrs: 'type="submit"',
      wrapInForm: true,
      clickHandler: (document) => {
        const form = document.getElementById("theForm");
        if (form) form.innerHTML = `<div data-reset="${"x".repeat(2000)}"></div>`;
      },
    });

    try {
      const result = await runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      });
      // The submit-shaped step must NOT be credited as verified from the
      // weak DOM-only signal alone — it must not advance past step 0.
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies, so the (non-optional) step throws.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });

  it("still verifies the SAME weak-signal shape when the xpathTail-retargeted control is NOT submit-shaped (no regression)", async () => {
    const { page, stagehand, steps } = buildFixture({
      controlTag: "span",
      controlAttrs: 'role="button" tabindex="0"',
      wrapInForm: false,
      clickHandler: (document) => {
        const control = document.getElementById("theControl");
        if (control) {
          const marker = document.createElement("div");
          marker.setAttribute("data-expanded", "x".repeat(2000));
          control.appendChild(marker);
        }
      },
    });
    const { logger, info } = makeLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(1);
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(true);
  });
});
