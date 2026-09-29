import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-003: `resolvedClickTargetIsSubmitShaped`'s primary-xpath-hit
 * branch (flow-runner.ts, distinct from the xpathTail-retarget branch covered
 * by flow-runner.n16-retarget-submit-shape-probe.test.ts) must apply the same
 * widened, tag/role-agnostic predicate submit-control.ts's ranking already
 * uses, instead of its own narrower tag/type-only check. A tag/role-agnostic
 * control whose accessible name reads a generic action verb (no literal
 * "submit") must now read as submit-shaped, while a genuinely non-submit
 * control ("Save draft") must not. A generic example company's
 * account-creation form.
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
 * Builds a two-step flow whose first step's `el.click()` resolves via the
 * n+16 fallback's PRIMARY xpath (never staled, so the tail-retarget branch is
 * never reached) against `controlTag`/`controlAttrs`/label text, mirroring
 * flow-runner.submit-shaped-weak-signal-veto-acceptance.test.ts's fixture
 * shape. `wrapInForm` defaults to false (preserving the original fixture
 * shape); the bugfix-003 sole-candidate/explicit-submit cases below opt in
 * since SUBMIT_SHAPE_FALLBACK_EXPR's no-text branch requires a form-like
 * ancestor to search for sibling candidates.
 */
function buildFixture(params: {
  controlTag: string;
  controlAttrs: string;
  label: string;
  wrapInForm?: boolean;
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
  const containerOpenTag = params.wrapInForm ? '<form id="theForm">' : "<div>";
  const containerCloseTag = params.wrapInForm ? "</form>" : "</div>";
  document.body.innerHTML = `
    <div class="wizardFooter">
      ${containerOpenTag}
        <${params.controlTag} id="theControl" ${params.controlAttrs}>${params.label}</${params.controlTag}>
      ${containerCloseTag}
      <a id="detailsLink" href="#details">Details</a>
    </div>
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

describe("flow-runner resolvedClickTargetIsSubmitShaped — primary-xpath-hit branch applies the widened predicate", () => {
  it("classifies a tag/role-agnostic, generic-action-verb-labeled control (no literal 'submit') as submit-shaped, vetoing weak-signal-only credit", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "div",
      controlAttrs: "",
      label: "Create Account",
      clickHandler: (document) => {
        const control = document.getElementById("theControl");
        if (control) {
          const marker = document.createElement("div");
          marker.setAttribute("data-reset", "x".repeat(2000));
          control.appendChild(marker);
        }
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
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies from the weak DOM-only signal alone.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });

  it("still verifies the SAME weak-signal shape on a genuinely non-submit, negative-worded control (no regression)", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "div",
      controlAttrs: 'role="button" tabindex="0"',
      label: "Save draft",
      clickHandler: (document) => {
        const control = document.getElementById("theControl");
        if (control) {
          const marker = document.createElement("div");
          marker.setAttribute("data-expanded", "x".repeat(2000));
          control.appendChild(marker);
        }
      },
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

  it('classifies a BUTTON with an explicit type="submit" attribute inside a form as submit-shaped (bugfix-001 non-regression: bug #10\'s explicit-type case)', async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "button",
      controlAttrs: 'type="submit"',
      label: "Continue",
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
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies from the weak DOM-only signal alone.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });

  it("classifies a no-text control that is the sole actionable candidate in its form as submit-shaped (bugfix-001 non-regression: bug #10's sole-candidate case)", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture({
      controlTag: "div",
      controlAttrs: 'role="button" tabindex="0" aria-label=""',
      label: "",
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
      expect(result.lastStepIndex).toBeLessThan(1);
    } catch {
      // Expected: step 0 never verifies from the weak DOM-only signal alone.
    }
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });
});
