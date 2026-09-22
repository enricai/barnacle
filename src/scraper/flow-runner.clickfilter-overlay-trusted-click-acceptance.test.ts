import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (recon-clickfilter-overlay-click-not-forwarded-to-hidden-
 * submit.md, "Requested item 1"): an accessibility-overlay pattern — an
 * interactive `role=button tabindex=0` div positioned exactly over an
 * `aria-hidden tabindex=-2` real control — forwards a genuine trusted
 * browser click to the real control's handler, but the handler ignores a
 * synthetic `PointerEvent`/`MouseEvent` construction + `el.click()`
 * dispatched from inside `page.evaluate()` (isTrusted=false by
 * construction). Stagehand's own `act()` never actually touches the DOM in
 * this fixture (mocked, matching every other offline acceptance test in this
 * suite) so the ONLY thing capable of producing a real DOM effect is the
 * n+16 fallback's click delivery — meaning this fixture only passes when
 * that delivery is a genuinely trusted gesture, not the synthetic dispatch.
 *
 * The fake `frameTarget`/`page.locator().first().click()` (the trusted-click
 * primitive n+16 now reuses from `trusted-click-retry`) marks a
 * `window.__n16TrustedGestureActive` flag before invoking the SAME
 * `overlay.click()` DOM call the synthetic evaluate() path also uses — the
 * overlay's own click listener only forwards the activation to the real
 * control when that flag is set, modeling a real browser's isTrusted gate
 * without needing a genuine CDP-level trusted event in this offline harness.
 * Before bugfix-001, n+16 always activated via the synthetic evaluate()
 * dispatch alone — the flag is never set — so the real control's handler
 * never fires and the step never heals. Site-agnostic fixture (generic
 * careers-application overlay button), not any real site or plugin.
 */

const BASE_URL = "https://apply.example.com/step/1";
const OVERLAY_STEP = "Click the 'Continue' button to advance";

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

describe("flow-runner n+16 fallback — click_filter overlay resolves via trusted click delivery (offline fixture, live happy-dom, no network)", () => {
  it("heals a step whose overlay click_filter pair only forwards a genuinely trusted gesture to the real control", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="wizardFooter">
        <button id="realControl" aria-hidden="true" tabindex="-2">Continue</button>
        <div id="overlay" role="button" tabindex="0"></div>
      </div>
    `;

    const overlayEl = document.getElementById("overlay") as unknown as HappyDomElement;
    const realControlEl = document.getElementById("realControl") as unknown as HappyDomElement;
    expect(overlayEl).not.toBeNull();
    expect(realControlEl).not.toBeNull();

    const overlayXPath = absoluteXPathFor(overlayEl);

    let realControlActivations = 0;
    (
      overlayEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      // A real browser's accessibility-overlay pattern forwards a genuinely
      // trusted user gesture through to the co-located real control's
      // handler but ignores an untrusted (script-dispatched) one — modeled
      // here via the flag the trusted-click primitive sets, since happy-dom
      // (like jsdom) never marks a script-dispatched event `isTrusted`.
      const win = window as unknown as { __n16TrustedGestureActive?: boolean };
      if (!win.__n16TrustedGestureActive) return;
      realControlActivations += 1;
      const marker = document.createElement("div");
      marker.setAttribute("data-activated", "true");
      marker.textContent = "x".repeat(8_000);
      document.body.appendChild(marker);
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
      url: () => BASE_URL,
      title: async () => "Apply — Step 1",
      // The trusted-click delivery primitive n+16 now reuses from
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
        actionDescription: OVERLAY_STEP,
        actions: [{ selector: `xpath=${overlayXPath}`, description: "Continue", method: "click" }],
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
      { instruction: OVERLAY_STEP, optional: false, upload: false, submitStep: false },
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
  });
});
