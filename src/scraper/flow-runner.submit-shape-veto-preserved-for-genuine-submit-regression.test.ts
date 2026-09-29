import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Non-regression companion to bugfix-001's narrowing (2b587a7): a bare,
 * default-type `<button>` merely owned by a `<form>` no longer gets
 * unconditional submit-shape credit, but a GENUINELY submit-shaped native
 * control — `<input type="submit">`, `<input type="image">`, or a
 * `<button>`/`<input>` carrying an EXPLICIT `type="submit">` — must still be
 * read as submit-shaped and still vetoed on DOM-delta-only "verification" at
 * BOTH flow-runner.ts decision sites: the primary-xpath-hit branch of
 * `resolvedClickTargetIsSubmitShaped` (covered by
 * flow-runner.resolved-click-target-widened-submit-shape.test.ts for the
 * generic-action-verb case only) and the xpathTail-retarget branch inside
 * `XPATH_TAIL_RETARGET_RESOLVE_FN_SRC` (covered by
 * flow-runner.n16-retarget-submit-shape-probe.test.ts for an explicit
 * `type="submit"` `<button>` only). This file adds the native
 * `type="submit"`/`type="image"` `<input>` cases neither of those files
 * exercises, at both sites, so bug #10 (the submit-target/submit-shape
 * resolution gap 1.12.71 shipped 077d0c5/731a910/4621d29 to fix) cannot
 * silently reopen if a future change widens the veto's carve-out too far. A
 * generic example company's account-creation form.
 */

const BASE_URL = "https://accounts.example.com/create";
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
 * Mirrors flow-runner.resolved-click-target-widened-submit-shape.test.ts's
 * fixture: a two-step flow whose first step's `el.click()` resolves via the
 * n+16 fallback's PRIMARY xpath (never staled), exercising
 * `resolvedClickTargetIsSubmitShaped`'s primary-xpath-hit branch only.
 */
function buildPrimaryXPathFixture(params: { controlTag: string; controlAttrs: string }): {
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
    <form id="theForm">
      <div class="wizardFooter">
        <${params.controlTag} id="theControl" ${params.controlAttrs}></${params.controlTag}>
        <a id="detailsLink" href="#details">Details</a>
      </div>
    </form>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
  if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

  const controlXPath = absoluteXPathFor(controlEl);
  const detailsLinkXPath = absoluteXPathFor(detailsLinkEl);

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    const form = document.getElementById("theForm");
    if (form) {
      const marker = document.createElement("div");
      marker.setAttribute("data-reset", "x".repeat(2000));
      form.appendChild(marker);
    }
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    // Never staled — the primary xpath always resolves, so the tail-retarget
    // branch (`expr.startsWith("//")`) is never exercised by this fixture.
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
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
    title: async () => "Create your account",
    locator: () => ({
      first: () => ({
        click: async () => {
          (controlEl as unknown as { click: () => void }).click();
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

/**
 * Mirrors flow-runner.n16-retarget-submit-shape-probe.test.ts's fixture: the
 * recorded primary xpath is deliberately staled by a decoy sibling ahead of
 * the control's container, forcing every attempt through
 * `XPATH_TAIL_RETARGET_RESOLVE_FN_SRC`'s tail-retarget branch.
 */
function buildTailRetargetFixture(params: { controlTag: string; controlAttrs: string }): {
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
        <form id="theForm">
          <${params.controlTag} id="theControl" ${params.controlAttrs}></${params.controlTag}>
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
  ).addEventListener("click", () => {
    const form = document.getElementById("theForm");
    if (form) form.innerHTML = `<div data-reset="${"x".repeat(2000)}"></div>`;
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
      const node = resolveTailXPath(documentElement, expr.slice(2));
      const matches = node ? [node] : [];
      return { snapshotLength: matches.length, snapshotItem: (i: number) => matches[i] ?? null };
    }
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
    title: async () => "Create your account",
    // A real Playwright `.locator(xpath)` only resolves the PRIMARY
    // xpath, which is now stale, so the trusted-click delivery attempt must
    // fail exactly like it would against a genuinely stale selector,
    // falling through to the n+16 fallback's tail-retarget `clickExpr`.
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

async function expectStillVetoed(fixture: {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
}): Promise<void> {
  const { page, stagehand, steps, logger, info } = fixture;
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
    // Expected: step 0 never verifies from the weak DOM-only signal alone.
  }
  expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
}

describe("flow-runner submit-shape veto — genuinely submit-shaped controls remain vetoed (bug #10 not reopened)", () => {
  describe("resolvedClickTargetIsSubmitShaped primary-xpath-hit branch", () => {
    it('still vetoes a native <input type="submit"> on DOM-delta-only verification', async () => {
      await expectStillVetoed(
        buildPrimaryXPathFixture({
          controlTag: "input",
          controlAttrs: 'type="submit" value="Create"',
        })
      );
    });

    it('still vetoes a native <input type="image"> on DOM-delta-only verification', async () => {
      await expectStillVetoed(
        buildPrimaryXPathFixture({
          controlTag: "input",
          controlAttrs: 'type="image" src="go.png" alt="Go"',
        })
      );
    });

    it('still vetoes an explicit <button type="submit"> on DOM-delta-only verification', async () => {
      await expectStillVetoed(
        buildPrimaryXPathFixture({ controlTag: "button", controlAttrs: 'type="submit"' })
      );
    });
  });

  describe("XPATH_TAIL_RETARGET_RESOLVE_FN_SRC tail-retarget branch", () => {
    it('still vetoes a native <input type="submit"> reached via xpathTail retarget', async () => {
      await expectStillVetoed(
        buildTailRetargetFixture({
          controlTag: "input",
          controlAttrs: 'type="submit" value="Create"',
        })
      );
    });

    it('still vetoes a native <input type="image"> reached via xpathTail retarget', async () => {
      await expectStillVetoed(
        buildTailRetargetFixture({
          controlTag: "input",
          controlAttrs: 'type="image" src="go.png" alt="Go"',
        })
      );
    });
  });
});
