import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001's second requested item (recon-n16-trusted-click-fails-
 * silently-falls-back-to-synthetic.md): when `attemptN16TrustedClick`'s
 * top-window branch (`frameTarget.frame` absent) fails — here the watchdog-
 * wrapped `locator().first().click()` rejects — the n+16 probe log line for
 * that step+attempt must carry a non-empty failure reason
 * (`trustedClickReason=`/`trustedClickError=`) alongside
 * `delivery=synthetic-fallback`, not a bare delivery tag with zero
 * diagnostic trace. The step still heals via the existing synthetic
 * `evaluate()` dispatch (fired=true) exactly as before. Site-agnostic
 * fixture (generic careers-application "Continue" control), not any real
 * site or plugin.
 */

const BASE_URL = "https://apply.example.com/step/1";
const CONTINUE_STEP = "Click the 'Continue' button to advance";

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

describe("flow-runner n+16 fallback — top-window trusted-click failure surfaces a captured reason (offline fixture, live happy-dom, no network)", () => {
  it("logs a non-empty failure reason alongside delivery=synthetic-fallback when locator().first().click() rejects", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="wizardFooter">
        <button id="realControl">Continue</button>
      </div>
    `;

    const realControlEl = document.getElementById("realControl") as unknown as HappyDomElement;
    expect(realControlEl).not.toBeNull();

    const realControlXPath = absoluteXPathFor(realControlEl);

    let clickActivations = 0;
    (
      realControlEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickActivations += 1;
      const marker = document.createElement("div");
      marker.setAttribute("data-activated", "true");
      marker.textContent = "x".repeat(8_000);
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
      url: () => BASE_URL,
      title: async () => "Apply — Step 1",
      // The top-window trusted-click delivery primitive: rejects, modeling
      // a real Playwright actionability failure (e.g. an obscured control),
      // so `attemptN16TrustedClick` falls through its outer catch with
      // `reason: "not-actionable"`/`"threw"` instead of delivering.
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
        actionDescription: CONTINUE_STEP,
        actions: [
          { selector: `xpath=${realControlXPath}`, description: "Continue", method: "click" },
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
      { instruction: CONTINUE_STEP, optional: false, upload: false, submitStep: false },
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
    expect(clickActivations).toBe(1);

    const n16ProbeLines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe"));
    const deliveredViaFallback = n16ProbeLines.filter((line) =>
      line.includes("delivery=synthetic-fallback")
    );
    expect(deliveredViaFallback.length).toBeGreaterThan(0);
    expect(deliveredViaFallback.some((line) => line.includes("fired=true"))).toBe(true);
    expect(
      deliveredViaFallback.every((line) =>
        /trustedClickReason=(timeout|no-candidate|not-actionable|threw)/.test(line)
      )
    ).toBe(true);
    expect(deliveredViaFallback.every((line) => /trustedClickError=.+/.test(line))).toBe(true);
  });
});
