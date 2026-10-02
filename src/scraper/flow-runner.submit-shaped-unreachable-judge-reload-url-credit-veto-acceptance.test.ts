import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the general form of the url-credit chokepoint fix (f0acfc8,
 * "route urlChanged through hasOriginOrPathChanged"): the raw
 * `post.url !== pre.url` comparison was wrong for EVERY consumer of
 * `urlChanged`, not only the reported non-submit-shaped step. The defect
 * report's own rationale calls this out explicitly: the comparison "is
 * equally wrong for submit-shaped steps whose submit-judge never runs, e.g.
 * when requireSubmitEndpoint is false."
 *
 * `hasSubmitTransitionSignal` (flow-runner.ts) only decides whether the
 * Haiku `verifySubmitWithLLM` judge re-litigates an already-`verified`
 * step; it does not itself correct the weak `urlChanged` value feeding
 * `verified` / `record.verifiedBy`. So a `submitStep: true` step whose
 * resolved element is NOT attribute-detected as submit-shaped
 * (`resolvedElementIsSubmitShaped: false`) and whose flow configures no
 * `submitEndpointPattern` (`requireSubmitEndpoint: false`) never reaches
 * the judge gate at all — if the pre-fix comparison were still in place, a
 * cosmetic query-string-only reload would ride straight through as
 * `verified: true, verifiedBy: "url"` with nothing downstream ever
 * re-checking it.
 *
 * Mirrors flow-runner.submit-shaped-weak-signal-veto-acceptance.test.ts's
 * offline happy-dom harness: Stagehand's own `act()` never touches the DOM,
 * so only the n+16 fallback's own `el.click()` can produce a real page
 * effect, forcing the cascade through the exact `urlChanged` computation
 * under test.
 */

const BASE_URL = "https://apply.example.com/step/1";
const SUBMIT_STEP_INSTRUCTION = "Click the 'Submit' button";

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
 * Builds the offline fixture: a single `submitStep: true` step whose
 * resolved control is a plain, non-submit-shaped `<div role="button">`
 * (never a `<button type="submit">` or `<input type="submit">`, so
 * `resolvedClickTargetIsSubmitShaped` reads false), and whose real
 * `el.click()` handler mutates ONLY the tracked page URL by appending a
 * cosmetic query param — no DOM content changes, so no other signal
 * (view-swap, form-value, dom-selection) can accidentally credit the step.
 * `page.url()` reads the SAME mutable `state.url` both pre- and post-click,
 * so the pre/post pair exercises the real `hasOriginOrPathChanged` read
 * path rather than a canned pair of literals.
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
    <div class="wizardFooter">
      <div id="theControl" role="button" tabindex="0">Submit</div>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  if (!controlEl) throw new Error("fixture setup failed");

  const controlXPath = absoluteXPathFor(controlEl);

  const state = { url: BASE_URL };

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Cosmetic reload: same origin, same path, only the query string moves —
    // the exact shape hasOriginOrPathChanged must NOT treat as a navigation.
    state.url = `${BASE_URL}?reloaded=1`;
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
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
    url: () => state.url,
    title: async () => "Apply — Step 1",
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
    // Stagehand's own act() never touches the DOM, so only n+16's own click
    // delivery (page.locator(...).first().click() above) can produce a real
    // page effect, forcing the cascade through the exact urlChanged
    // computation under test.
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

  const steps: HealingFlowStep[] = [
    { instruction: SUBMIT_STEP_INSTRUCTION, optional: false, upload: false, submitStep: true },
  ];

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, steps, logger, info, warn };
}

describe("flow-runner submit-shaped step with unreachable submit-judge — bare URL reload credit veto", () => {
  it("does NOT credit a submitStep:true step as verified via url from a cosmetic query-string-only reload, when the resolved control is not submit-shaped and no submitEndpointPattern leaves requireSubmitEndpoint false (judge never engages)", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        // No submitEndpointPattern configured: requireSubmitEndpoint stays
        // false, so the Haiku submit-judge re-litigation never engages —
        // hasSubmitTransitionSignal's gate is unreachable for this step.
        submitEndpointPattern: null,
      })
    ).rejects.toBeTruthy();

    // Must never have been credited as verified via the stale raw url
    // comparison — not on the first attempt, and not via a "url" verdict
    // logged on any later attempt either.
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
    expect(info.some((line) => line.includes("verifiedBy=url"))).toBe(false);
  });
});
