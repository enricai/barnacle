import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for bugfix-001 (bare-in-form-button-submit-shape-
 * corroboration-fixed): a plain, default-type `<button>` nested inside a
 * `<form>` — with no `type="submit"`, a toggle-phrase accessible name (no
 * generic action verb), and multiple other actionable sibling controls in
 * the same form (so it is not even the sole-candidate fallback) — must be
 * classified NOT submit-shaped end to end. Exercises BOTH resolution paths
 * `resolvedClickTargetIsSubmitShaped` supports: a direct primary-xpath hit,
 * and the n+16 fallback's `xpathTailForRetarget` re-anchor used when the
 * primary xpath is stale. A resulting attempt whose only signal is a real
 * htmlDelta/textChanged/formValueChanged reveal (no network, no URL change)
 * must be credited `verified=true` by classifyPhantomClick's
 * isSubmitShapedStep veto — never swept into it merely for living in a
 * `<form>`.
 */

const BASE_URL = "https://apply.example.com/step/1";
const STEP_INSTRUCTION = "Click the toggle to reveal the extra fields";
const HARMLESS_SECOND_STEP = "Click the 'Details' link";
const TOGGLE_LABEL = "Show additional options";

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

// Mirrors xpathTailForRetarget's own loose leaf(+parent)-tag/position match,
// used only by the retarget-path fixture below.
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
 * Builds the shared offline fixture: a two-step flow whose first step clicks
 * an unmarked, default-type `<button>` (`TOGGLE_LABEL`, no `type="submit"`)
 * inside a `<form>` that also owns two other actionable sibling buttons —
 * ruling out both the native-type tier and the sole-candidate fallback tier
 * of `SUBMIT_SHAPE_EXPR`. `staleTargetXPath: true` inserts a decoy sibling
 * ahead of the form's container, exactly like
 * flow-runner.n16-retarget-submit-shape-probe.test.ts, forcing every attempt
 * through the n+16 fallback's `xpathTailForRetarget` re-anchor instead of a
 * direct primary-xpath hit — the second call-path `resolvedClickTargetIsSubmitShaped`
 * supports.
 */
function buildFixture(staleTargetXPath: boolean): {
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
      <div class="signupPanel">
        <form id="theForm">
          <button id="theControl" type="button">${TOGGLE_LABEL}</button>
          <button id="saveDraftBtn" type="button">Save draft</button>
          <button id="cancelBtn" type="button">Cancel</button>
        </form>
        <a id="detailsLink" href="#details">Details</a>
      </div>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
  if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

  const controlXPath = absoluteXPathFor(controlEl);
  const detailsLinkXPath = absoluteXPathFor(detailsLinkEl);

  if (staleTargetXPath) {
    // Stale the primary xpath: insert a decoy sibling ahead of `.signupPanel`
    // so the recorded absolute path walks into an empty decoy subtree — the
    // control itself never moved, only every ancestor's positional index
    // shifted, forcing resolution through the xpathTail retarget.
    const pageDiv = document.querySelector(".page") as unknown as HappyDomElement;
    const decoy = document.createElement("div");
    (
      pageDiv as unknown as {
        insertBefore: (n: HappyDomElement, ref: HappyDomElement | null) => void;
      }
    ).insertBefore(decoy, pageDiv.firstElementChild ?? null);
  }

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    const form = document.getElementById("theForm");
    if (!form) return;
    const revealed = document.createElement("div");
    revealed.setAttribute("data-revealed-fields", "x".repeat(2000));
    form.appendChild(revealed);
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
  (
    document as unknown as {
      evaluate: (
        expr: string,
        ctx: unknown,
        ns: unknown,
        type: number
      ) => {
        singleNodeValue?: unknown;
        snapshotLength?: number;
        snapshotItem?: (i: number) => unknown;
      };
    }
  ).evaluate = (expr: string, _ctx: unknown, _ns: unknown, type: number) => {
    if (expr.startsWith("//") && type === 7) {
      const node = staleTargetXPath ? resolveTailXPath(documentElement, expr.slice(2)) : null;
      const matches = node ? [node] : [];
      return { snapshotLength: matches.length, snapshotItem: (i: number) => matches[i] ?? null };
    }
    const node = expr.startsWith("//")
      ? staleTargetXPath
        ? resolveTailXPath(documentElement, expr.slice(2))
        : null
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
    // when staled, this throws exactly like a genuinely stale selector,
    // forcing the click through the n+16 fallback's `clickExpr` (which
    // performs the tail retarget) instead.
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

describe("flow-runner — plain in-form toggle button is never swept into the submit-shape veto", () => {
  it("credits verified=true from htmlDelta alone when the control resolves via a direct primary-xpath hit", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture(false);

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

  it("credits verified=true from htmlDelta alone when the control resolves ONLY via the xpathTail retarget", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture(true);

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
