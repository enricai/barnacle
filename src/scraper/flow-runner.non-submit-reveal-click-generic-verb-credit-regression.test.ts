import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's exact failure shape at `resolvedClickTargetIsSubmitShaped`'s
 * decision site (submit-control.ts's `SUBMIT_SHAPE_EXPR`, fixed by "Require
 * corroboration for explicit type=submit controls in SUBMIT_SHAPE_EXPR"): a
 * `<button type="submit">` whose click handler is JS-intercepted (calls
 * `preventDefault()` and only toggles hidden fields — never actually submits
 * or navigates) but carries a real, non-empty, non-generic-verb, non-negative
 * accessible name ("Reveal contact form" / "Sign in with account") must still
 * verify from ordinary htmlDelta/textChanged/formValueChanged signals alone,
 * instead of being swept into the stricter network/URL-only submit veto
 * merely because it structurally resembles a submit control. Each fixture
 * gives the control multiple actionable sibling controls in its `<form>` so
 * neither the generic-action-verb nor the sole-actionable-candidate
 * corroboration fallback could rescue the assertion by coincidence — the
 * control must be credited because `SUBMIT_SHAPE_EXPR` no longer grants
 * unconditional structural credit to an explicit `type="submit"`, not because
 * of an unrelated fallback branch. Covers both `resolvedClickTargetIsSubmitShaped`
 * resolution paths: this file's first case resolves the control via the
 * primary xpath (mirroring flow-runner.resolved-click-target-widened-submit-shape.test.ts's
 * fixture shape); the second resolves it via the xpathTail-retarget (n+16
 * fallback) path after staling the primary xpath (mirroring
 * flow-runner.n16-retarget-submit-shape-probe.test.ts's fixture shape). A
 * fictitious example domain/company throughout — never the real reported site.
 */

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

// Mirrors xpathTailForRetarget's own re-anchor: matches only the leaf's (and,
// if present, its immediate parent's) tag + same-tag-sibling position,
// ignoring every ancestor above that.
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
 * Builds a two-step flow whose first step clicks a
 * `<button type="submit">` with a plain, non-generic-verb accessible name,
 * sitting alongside two other actionable sibling controls in the same
 * `<form>` (so neither the generic-action-verb nor the
 * sole-actionable-candidate-in-form fallback could rescue credit). The click
 * handler intercepts the event (`preventDefault()`) and only toggles two
 * hidden fields — no navigation, no network submission — a weak,
 * page-wide htmlDelta signal.
 *
 * `staleprimary` controls which `resolvedClickTargetIsSubmitShaped`
 * resolution path is exercised: `false` resolves via the primary xpath
 * (never staled); `true` inserts a decoy sibling ahead of the control's
 * container so the recorded primary xpath resolves into an empty decoy
 * subtree, forcing resolution through the xpathTail-retarget (n+16
 * fallback) path.
 */
function buildFixture(params: { baseUrl: string; label: string; staleprimary: boolean }): {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: params.baseUrl });
  const document = window.document;
  document.body.innerHTML = `
    <div class="page">
      <div class="wizardFooter">
        <form id="theForm">
          <button id="theControl" type="submit">${params.label}</button>
          <button id="siblingOne" type="button">Cancel</button>
          <button id="siblingTwo" type="button">Skip for now</button>
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

  if (params.staleprimary) {
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
  ).addEventListener("click", (ev: unknown) => {
    (ev as { preventDefault: () => void }).preventDefault();
    const form = document.getElementById("theForm");
    if (form) {
      const hiddenOne = document.createElement("input");
      hiddenOne.setAttribute("type", "hidden");
      hiddenOne.setAttribute("data-revealed", "true");
      form.appendChild(hiddenOne as unknown as HappyDomElement);
      const hiddenTwo = document.createElement("input");
      hiddenTwo.setAttribute("type", "hidden");
      hiddenTwo.setAttribute("data-expanded", "x".repeat(2000));
      form.appendChild(hiddenTwo as unknown as HappyDomElement);
    }
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
      const node = params.staleprimary ? resolveTailXPath(documentElement, expr.slice(2)) : null;
      const matches = node ? [node] : [];
      return { snapshotLength: matches.length, snapshotItem: (i: number) => matches[i] ?? null };
    }
    const node = expr.startsWith("//")
      ? params.staleprimary
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
    url: () => params.baseUrl,
    title: async () => "Apply — Step 1",
    locator: (selector: unknown) => ({
      first: () => ({
        click: async () => {
          if (!params.staleprimary) {
            (controlEl as unknown as { click: () => void }).click();
            return;
          }
          // A real Playwright `.locator(xpath)` only resolves the PRIMARY
          // xpath, so the trusted-click delivery attempt must fail exactly
          // like it would against a genuinely stale selector, falling
          // through to the synthetic `clickExpr` fallback under test.
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

describe("flow-runner resolvedClickTargetIsSubmitShaped — explicit type=submit, JS-intercepted reveal control is not phantom-vetoed", () => {
  it('verifies, via the primary-xpath resolution path, a <button type="submit">Reveal contact form</button> whose click only toggles hidden fields, from DOM-delta alone', async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      baseUrl: "https://accounts.example.com/create",
      label: "Reveal contact form",
      staleprimary: false,
    });

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

  it('verifies, via the xpathTail-retarget (n+16 fallback) resolution path, a <button type="submit">Sign in with account</button> whose click only toggles hidden fields, from DOM-delta alone', async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      baseUrl: "https://apply.example.com/step/1",
      label: "Sign in with account",
      staleprimary: true,
    });

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
