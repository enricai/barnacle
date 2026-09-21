import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (recon-clickfilter-overlay-click-not-forwarded-to-hidden-
 * submit.md) for the SUBMIT-SHAPED case specifically: a `submitStep: true`
 * step whose resolved target is an `aria-hidden tabindex=-2` real control
 * sitting under an interactive `role=button tabindex=0` overlay at the
 * identical bounding box. The n+16 fallback's own click-delivery primitive
 * (`attemptN16TrustedClick`, reused from `trusted-click-retry`) must deliver
 * a genuinely trusted (`isTrusted=true`) gesture to the overlay, not the
 * synthetic `page.evaluate()` `PointerEvent`/`MouseEvent` construction +
 * `el.click()` dispatch `clickActivationExpr` builds — the fixture's real
 * control only forwards a trusted gesture to its handler, so a step credited
 * purely via the untrusted synthetic-dispatch path can never observe the URL
 * transition the handler fires, and must fail this test.
 *
 * Distinct from flow-runner.clickfilter-overlay-trusted-click-acceptance.test.ts
 * (a non-submit toggle step, `submitStep: false`): a submit-shaped step
 * disables the weak DOM-only verification signals that test's `verified`
 * relies on (see flow-runner.ts's `weakDomSignalsAllowed` /
 * `retrySubmitShaped` gates), so this fixture instead proves delivery via a
 * strong signal (a URL/origin transition the real control's own handler
 * fires) — the one strong signal a submit-shaped step's n+16 fallback still
 * accepts unconditionally. Site-agnostic fixture (a generic account-signup
 * wizard's "Create account" confirmation step), not any real site or plugin.
 */

const STEP_1_URL = "https://signup.example.com/step/1";
const STEP_2_URL = "https://signup.example.com/confirmation";
const SUBMIT_STEP = "Click 'Create account' to submit the signup form";

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

describe("flow-runner n+16 fallback — submit-shaped overlay/hidden-control pair resolves via trusted click delivery, not the synthetic el.click() fallback (offline fixture, live happy-dom, no network)", () => {
  it("heals a submit-shaped step whose overlay/hidden-confirm pair only forwards a genuinely trusted gesture to the real control", async () => {
    const window = new Window({ url: STEP_1_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="signupFooter">
        <button id="realConfirm" aria-hidden="true" tabindex="-2">Create account</button>
        <div id="overlay" role="button" tabindex="0"></div>
      </div>
    `;

    const overlayEl = document.getElementById("overlay") as unknown as HappyDomElement;
    const realConfirmEl = document.getElementById("realConfirm") as unknown as HappyDomElement;
    expect(overlayEl).not.toBeNull();
    expect(realConfirmEl).not.toBeNull();

    const overlayXPath = absoluteXPathFor(overlayEl);

    let realControlActivations = 0;
    (
      overlayEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      // Mirrors a real browser's accessibility-overlay pattern: the overlay
      // forwards a genuinely trusted user gesture to the co-located real
      // control's submit handler but ignores an untrusted (script-dispatched)
      // one. The n+16 trusted-click primitive marks this flag before
      // invoking the SAME `overlay.click()` DOM call the synthetic evaluate()
      // path also uses — happy-dom, like jsdom, never marks a script-
      // dispatched event `isTrusted`, so the flag is what distinguishes
      // delivery here.
      const win = window as unknown as { __n16TrustedGestureActive?: boolean };
      if (!win.__n16TrustedGestureActive) return;
      realControlActivations += 1;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown; __n16TrustedGestureActive?: boolean };
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
      // The real control's submit handler is the only thing capable of
      // moving the page in this fixture — it only fires when the click
      // reaches it via a trusted gesture, so a URL transition is only
      // observable when n+16's delivery was genuinely trusted, never via
      // the synthetic evaluate() dispatch alone.
      url: () => (realControlActivations > 0 ? STEP_2_URL : STEP_1_URL),
      title: async () => "Create account",
      // The trusted-click delivery primitive n+16 reuses from
      // `trusted-click-retry`: a REAL gesture arrives through here, never
      // through `evaluate()`. Marks the flag the overlay's listener gates
      // on, invokes the SAME element's native `.click()` (the DOM call
      // itself is identical either way — only the flag distinguishes a
      // trusted delivery from the synthetic evaluate() dispatch), then
      // clears it.
      locator: () => ({
        first: () => ({
          click: async () => {
            win.__n16TrustedGestureActive = true;
            try {
              (overlayEl as unknown as { click: () => void }).click();
            } finally {
              win.__n16TrustedGestureActive = false;
            }
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
      // Stagehand's own act() never touches the DOM in this fixture (as in
      // every other offline acceptance fixture in this suite) — it only
      // resolves the target selector. Only n+16's OWN click delivery can
      // produce a real DOM effect, so this fixture only heals when that
      // delivery is genuinely trusted.
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: SUBMIT_STEP,
        actions: [
          { selector: `xpath=${overlayXPath}`, description: "Create account", method: "click" },
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

    const STEPS: HealingFlowStep[] = [
      { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
    ];

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: STEPS,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(realControlActivations).toBe(1);

    const n16ProbeLines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe"));
    expect(n16ProbeLines.some((line) => line.includes("delivery=trusted"))).toBe(true);
    expect(n16ProbeLines.some((line) => line.includes("url=true"))).toBe(true);
    expect(n16ProbeLines.some((line) => line.includes("verified=true"))).toBe(true);
  });
});
