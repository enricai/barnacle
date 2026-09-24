import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression test for the reported defect shape (bugfix-002's
 * `submit-destination-judge-gate-widened` widened the judge trigger to fire
 * whenever the RESOLVED n+16 click target is objectively submit-shaped —
 * see `retryResolvedElementIsSubmitShaped` in flow-runner.ts). This pins the
 * sibling case the widening does NOT cover: `xpathTailForRetarget` re-anchors
 * on tag + same-tag-sibling position only (see its docblock), so when the
 * primary xpath goes stale, the retarget can land on a DIFFERENT live
 * element that merely shares the ORIGINAL control's tag and position — here,
 * a "sign in" button positioned where the "create account" submit button
 * used to resolve. That control is NOT submit-shaped, so
 * `retryResolvedElementIsSubmitShaped` correctly reports false — but the
 * click still fires a REAL navigation (URL + title change) to a destination
 * that satisfies none of the flow's configured success signals. A bare
 * `retryUrlChanged` must not unconditionally credit that as verified.
 *
 * Mirrors flow-runner.n16-retarget-submit-shape-probe.test.ts's fixture
 * shape (decoy sibling stales the primary xpath's ancestor-position chain,
 * forcing every attempt through the tail retarget) but swaps the weak
 * DOM-only signal (htmlDelta) for a strong one (a real URL/title
 * transition), which is the shape the report describes.
 */

const BASE_URL = "https://apply.example.com/step/1";
const STEP_INSTRUCTION = "Click the 'Create Account' button";
const HARMLESS_SECOND_STEP = "Click the 'Details' link";
const WRONG_DESTINATION_URL = "https://apply.example.com/sign-in";

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

// Mirrors xpathTailForRetarget's own loose re-anchor: matches only the
// leaf's (and its immediate parent's) tag + same-tag-sibling position,
// independent of any ancestor shift — the same mechanism that can land on
// an entirely unrelated element sharing only tag+position with the
// originally-resolved (now-stale) control.
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
 * Builds the offline fixture: a two-step flow whose first step's recorded
 * (Stagehand-resolved) xpath points at a "Create Account" submit button
 * that is deliberately staled (a decoy sibling shifts every ancestor's
 * positional index, exactly like flow-runner.n16-retarget-submit-shape-
 * probe.test.ts), forcing the n+16 fallback through its xpathTail
 * re-anchor. The live DOM at that tag+position is instead a plain
 * `<button type="button">` "Sign in" control — NOT submit-shaped — whose
 * click performs a real client-side navigation to a page carrying none of
 * the flow's success signals.
 */
function buildFixture(): {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="page">
      <div class="wizardFooter">
        <div class="footerInner">
          <button id="theControl" type="button">Sign in</button>
        </div>
      </div>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  if (!controlEl) throw new Error("fixture setup failed");
  // The RECORDED xpath: what Stagehand's act() resolved BEFORE the page
  // re-rendered — the button was, at that time, the "Create Account" submit
  // control at this exact tag+position (this fixture only needs the xpath
  // shape, not a literal second element, since Stagehand's act() below
  // never touches the DOM itself).
  const recordedXPath = absoluteXPathFor(controlEl);

  // Stale the primary xpath: insert a decoy sibling ahead of `.wizardFooter`
  // so the recorded absolute path now walks into an empty decoy subtree —
  // the live control never moved, only every ancestor's positional index
  // shifted, forcing every attempt through the xpathTail-retarget branch.
  const pageDiv = document.querySelector(".page") as unknown as HappyDomElement;
  const decoy = document.createElement("div");
  (
    pageDiv as unknown as {
      insertBefore: (n: HappyDomElement, ref: HappyDomElement | null) => void;
    }
  ).insertBefore(decoy, pageDiv.firstElementChild ?? null);

  let navigated = false;
  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    navigated = true;
  });

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
    url: () => (navigated ? WRONG_DESTINATION_URL : BASE_URL),
    title: async () => (navigated ? "Sign In" : "Apply — Step 1"),
    // A real Playwright `.locator(xpath)` only resolves the PRIMARY xpath —
    // it has no knowledge of the n+16 fallback's own xpathTail re-anchor —
    // so the trusted-click delivery attempt fails exactly like Stagehand's
    // reported "Could not find an element for the given xPath(s)", falling
    // through to the synthetic `clickExpr` fallback under test.
    locator: (selector: unknown) => ({
      first: () => ({
        click: async () => {
          const xp = String(selector).replace(/^xpath=/, "");
          const el = resolveAbsoluteXPath(documentElement, xp);
          if (!el) throw new Error("Could not find an element for the given xPath(s)");
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
    // n+16 fallback's own xpathTail resolution, which is the only thing
    // that can produce a DOM/URL effect.
    act: vi.fn().mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [
        { selector: `xpath=${recordedXPath}`, description: "Create Account", method: "click" },
      ],
    })),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  const steps: HealingFlowStep[] = [
    { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
    { instruction: HARMLESS_SECOND_STEP, optional: true, upload: false, submitStep: false },
  ];

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, steps, logger, info, warn };
}

describe("flow-runner n+16 fallback — wrong-element xpathTail retarget must not be credited on an uncorroborated destination", () => {
  it("does NOT credit an UNFLAGGED, non-final step whose fallback click lands, via xpathTail retarget, on a different non-submit-shaped element that navigates to a page with no success signals", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture();

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
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies, so the (non-optional) step throws.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });
});
