import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Mirror-image regression pin for bugfix-002 (widened submit-destination
 * judge trigger, recon-trusted-click-throw-fallback-hits-wrong-element-
 * credited-as-success.md): when the trusted click throws and the n+16
 * synthetic `el.click()` fallback re-anchors via `xpathTailForRetarget` onto
 * the SAME correct submit control (no wrong-element substitution) and the
 * page lands on a destination consistent with the instructed submit, the
 * step must still be credited as verified. Isolates the fix's true-positive
 * path from the sibling wrong-element true-negative fixture so a broad fix
 * that vetoes all post-fallback navigation cannot pass both.
 */

const BASE_URL = "https://apply.example.com/signup";
const CONFIRMATION_URL = "https://apply.example.com/signup/confirmation";
const STEP_INSTRUCTION = "Click the 'Create Account' button to submit the signup form";

function makeLogger(): { logger: Logger; info: string[] } {
  const info: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info };
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

// A positional index with no matching child (the decoy subtree is empty)
// resolves to null, modeling a genuinely stale primary xpath.
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

// Mirrors xpathTailForRetarget's own re-anchor: leaf tag + same-tag-sibling
// position (and its immediate parent's), independent of any ancestor shift —
// this resolves onto the SAME leaf control the primary xpath used to name,
// never a different, nearby-but-wrong element.
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

describe("flow-runner n+16 fallback — correct-destination credit regression (no over-correction)", () => {
  it("credits the step as verified when the trusted click throws and the synthetic fallback lands on the CORRECT submit control, navigating to the instructed destination", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="page">
        <div class="signupFooter">
          <form id="signupForm">
            <button id="createAccount" type="submit">Create Account</button>
          </form>
        </div>
      </div>
    `;

    const controlEl = document.getElementById("createAccount") as unknown as HappyDomElement;
    if (!controlEl) throw new Error("fixture setup failed");
    const controlXPath = absoluteXPathFor(controlEl);

    // Stale the primary xpath exactly like the n+16 retarget-probe fixture:
    // insert a decoy sibling ahead of `.signupFooter` so the recorded
    // absolute path now walks into an empty decoy subtree. The leaf control
    // itself never moved — only every ancestor's positional index shifted —
    // so the tail retarget below resolves onto the SAME `createAccount`
    // button, not a different one.
    const pageDiv = document.querySelector(".page") as unknown as HappyDomElement;
    const decoy = document.createElement("div");
    (
      pageDiv as unknown as {
        insertBefore: (n: HappyDomElement, ref: HappyDomElement | null) => void;
      }
    ).insertBefore(decoy, pageDiv.firstElementChild ?? null);

    const submitCount = { n: 0 };
    (
      controlEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      submitCount.n += 1;
      // The genuinely intended, authenticated post-submit destination.
      const marker = document.createElement("div");
      marker.setAttribute("id", "signupConfirmed");
      document.body.appendChild(marker);
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
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
      // Same-origin navigation is consistent with the instructed submit —
      // NOT a plausible-but-wrong destination (e.g. a sibling sign-in link).
      url: () => (submitCount.n > 0 ? CONFIRMATION_URL : BASE_URL),
      title: async () => (submitCount.n > 0 ? "Signup — Confirmed" : "Signup"),
      // A real Playwright `.locator(xpath)` only resolves the PRIMARY
      // xpath, which is now stale (empty decoy subtree) — the trusted-click
      // delivery attempt throws "Could not find an element for the given
      // xPath(s)", exactly the reported failure mode, falling through to
      // the synthetic `clickExpr` fallback under test.
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
      // is the now-stale primary xpath, forcing the delivery attempt
      // through the n+16 fallback's own xpathTail resolution.
      act: vi.fn().mockImplementation(async () => ({
        success: true,
        message: "clicked",
        actionDescription: "clicked",
        actions: [
          { selector: `xpath=${controlXPath}`, description: "create account", method: "click" },
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

    const { logger, info } = makeLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: true }],
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      // Corroborates the fallback's real navigation as the genuine submitted
      // state, exactly as an operator's plugin config would supply — the
      // judge is unavailable (anthropic: null) so this DOM-state probe is
      // what the "judge unavailable" fallback policy checks.
      submittedStateSelectors: ["#signupConfirmed"],
    });

    expect(result.lastStepIndex).toBe(0);
    expect(submitCount.n).toBe(1);
    // The credit must be the genuine one: the synthetic fallback's own
    // navigation corroborated by the intended-destination DOM marker — not
    // merely "some line logged success" (which a vacuous pass-through could
    // also satisfy).
    expect(
      info.some((line) =>
        line.includes(
          "n+16 fallback submit verified via submitted-state DOM selector '#signupConfirmed'"
        )
      )
    ).toBe(true);
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(true);
  });
});
