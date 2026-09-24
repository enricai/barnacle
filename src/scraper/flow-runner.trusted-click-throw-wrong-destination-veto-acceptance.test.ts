import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins recon-trusted-click-throw-fallback-hits-wrong-element-credited-as-
 * success.md: a trusted click throws, the n+16 synthetic `el.click()`
 * fallback re-resolves the SAME xpath onto a different, real element (a DOM
 * shift moved the intended control out from under that path), clicks it, and
 * that element's own handler navigates the page to an unrelated destination.
 * Today `retryResolvedElementIsSubmitShaped` reads the WRONG element's own
 * (non-submit) shape, so the submit-destination judge gate never fires for
 * an unflagged bridge step, and the fallback's plain `retryUrlChanged` OR-
 * branch credits the step as verified with zero destination check. The step
 * must not be silently credited as succeeded on that attempt. Site-agnostic
 * fixture (generic "apply.example.com" careers-application flow), not any
 * real site or plugin.
 */

const BASE_URL = "https://apply.example.com/account/create";
const CREATE_ACCOUNT_STEP = "Click the 'Create account' button to submit the signup form";

const SILENT_LOGGER_CALLS = { info: [] as string[], warn: [] as string[] };
const testLogger = {
  info: vi.fn((msg: string) => SILENT_LOGGER_CALLS.info.push(msg)),
  warn: vi.fn((msg: string) => SILENT_LOGGER_CALLS.warn.push(msg)),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

describe("flow-runner n+16 fallback — trusted-click throw + fallback lands on a wrong-destination element (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the step as verified when the fallback resolves onto an element whose click navigates to an unrelated destination", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    // The intended "Create account" control lives at the same xpath depth as
    // an unrelated "Sign In" link elsewhere on the page. A simulated DOM
    // shift (a banner/notice inserted ahead of the intended control) is
    // modeled by simply placing the "wrong" element at the SAME absolute
    // xpath the intended control would occupy, mirroring the reported
    // fallback re-resolving the same path onto a different live node.
    document.body.innerHTML = `
      <div class="formFooter">
        <a id="signInLink" href="/account/sign-in">Sign In</a>
      </div>
    `;

    const wrongEl = document.getElementById("signInLink") as unknown as HappyDomElement;
    expect(wrongEl).not.toBeNull();
    const wrongElXPath = absoluteXPathFor(wrongEl);

    let clickActivations = 0;
    let currentUrl = BASE_URL;
    let currentTitle = "Create Account";
    (
      wrongEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickActivations += 1;
      // The wrong element's own handler navigates to an unrelated
      // destination — a generic Sign In page, not the account-creation
      // success state the instructed step asked for.
      currentUrl = "https://apply.example.com/account/sign-in";
      currentTitle = "Sign In";
      const marker = document.createElement("div");
      marker.setAttribute("data-navigated-away", "true");
      document.body.appendChild(marker);
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
      url: () => currentUrl,
      title: async () => currentTitle,
      // The top-window trusted-click delivery primitive: rejects, forcing
      // attemptN16TrustedClick down its outer catch and into the synthetic
      // el.click() fallback — same shape as the reported "trusted click
      // throws" precondition.
      locator: () => ({
        first: () => ({
          click: async () => {
            throw new Error("not actionable");
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
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: CREATE_ACCOUNT_STEP,
        actions: [
          { selector: `xpath=${wrongElXPath}`, description: "Create account", method: "click" },
        ],
      }),
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    // Unflagged bridge step — mirrors the report's replan-generated step
    // that never carries submitStep:true. A single-step flow keeps this
    // step non-final too (no isFinalStep-only escape hatch available), the
    // same shape the report's mid-flow bridge step had.
    const STEPS: HealingFlowStep[] = [
      { instruction: CREATE_ACCOUNT_STEP, optional: false, upload: false, submitStep: false },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: STEPS,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow(/failed verification/);

    expect(clickActivations).toBeGreaterThan(0);

    const n16ProbeLines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe"));
    const deliveredViaFallback = n16ProbeLines.filter((line) =>
      line.includes("delivery=synthetic-fallback")
    );
    expect(deliveredViaFallback.length).toBeGreaterThan(0);

    // The fallback clicked the wrong element and the page navigated to an
    // unrelated destination — the step must not be credited as verified on
    // any attempt.
    expect(deliveredViaFallback.every((line) => /verified=false/.test(line))).toBe(true);
  });
});
