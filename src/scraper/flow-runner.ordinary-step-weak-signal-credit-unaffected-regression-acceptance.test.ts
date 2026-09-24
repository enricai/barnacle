import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression for the submit-destination judge widening (`resolvedElementIs
 * SubmitShaped` OR'd into the `requireSubmitEndpoint` gate ahead of
 * `verifySubmitWithLLM`, flow-runner.ts ~line 12317): that gate is only
 * reached at all when `retryVerified` is already `true`, and `retryVerified`
 * for an unflagged, non-final, non-submit-shaped step is decided by the
 * SAME `weakDomSignalsAllowed` OR-branch flow-runner.submit-shaped-weak-
 * signal-veto-acceptance.test.ts already pins for the submit-shaped case —
 * the widening touched none of that boolean's inputs. This fixture is an
 * ordinary interior step (no `submitStep` flag, not the final step, and the
 * resolved control carries no submit-affordance attributes) whose click
 * produces only a benign html/text delta with no url or network change, so
 * it exercises exactly the OR-branch the widening must leave untouched.
 */

const BASE_URL = "https://apply.example.com/step/1";
const TOGGLE_STEP_INSTRUCTION = "Click the 'More options' toggle";
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

describe("flow-runner n+16 fallback — ordinary non-submit-shaped weak-signal credit unaffected by the destination-plausibility widening", () => {
  it("still credits an UNFLAGGED, non-final, non-submit-shaped step from a benign html/text delta alone (no url or network change)", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="optionsPanel">
        <div id="theControl" role="button" tabindex="0">More options</div>
        <a id="detailsLink" href="#details">Details</a>
      </div>
    `;

    const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
    const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
    if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

    const controlXPath = absoluteXPathFor(controlEl);

    (
      controlEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      const marker = document.createElement("div");
      marker.setAttribute("data-revealed", "x".repeat(2000));
      controlEl.appendChild(marker as unknown as HappyDomElement);
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
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
      // Stagehand's own act() never touches the DOM (matching every other
      // offline acceptance test in this suite), so only the n+16 fallback's
      // own el.click() can produce the DOM effect under test.
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
      { instruction: TOGGLE_STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
      { instruction: HARMLESS_SECOND_STEP, optional: true, upload: false, submitStep: false },
    ];

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
