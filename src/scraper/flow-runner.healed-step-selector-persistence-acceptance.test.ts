import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * bugfix-003: `executeStepWithHealing` returns "completed" on heal before
 * ever reaching the `onStepFailure`/`dumpStepFailure` diagnostic-bundle path
 * that serializes each attempt's `triedSelectors` — so there was no artifact
 * anywhere recording which element a HEALED step's fallback actually
 * targeted. This pins the new `onStepHeal` seam (symmetric to
 * `onStepFailure`): it must fire, with the resolved selector and technique,
 * exactly when a step verifies on attempt > 1.
 *
 * Reuses bugfix-001's n+16 trusted-click overlay fixture shape (Stagehand's
 * own `act()` never touches the DOM; only the n+16 fallback's trusted click
 * delivery can), but forces attempt 1 to fail outright (no actionable
 * candidate) so the heal happens on attempt 2 via the n+16 path — the exact
 * branch `onStepHeal` was added to. Site-agnostic fixture (a generic
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

describe("flow-runner onStepHeal — persists the healed step's resolved selector (offline fixture, live happy-dom, no network)", () => {
  it("invokes onStepHeal with the n+16-resolved selector/technique/attempt when a step verifies on attempt 2", async () => {
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

    let actCallCount = 0;
    const stagehand: Stagehand = {
      // Attempt 1 finds no actionable candidate at all, forcing the cascade
      // to escalate to attempt 2 (observe-act) — the resolved selector for
      // THAT attempt is what heals via the n+16 trusted-click fallback.
      act: vi.fn().mockImplementation(async () => {
        actCallCount += 1;
        if (actCallCount === 1) {
          return {
            success: false,
            message: "no actionable candidate",
            actionDescription: "",
            actions: [],
          };
        }
        return {
          success: true,
          message: "clicked",
          actionDescription: OVERLAY_STEP,
          actions: [
            { selector: `xpath=${overlayXPath}`, description: "Continue", method: "click" },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          instruction === OVERLAY_STEP
            ? [{ selector: `xpath=${overlayXPath}`, description: "Continue", method: "click" }]
            : []
        ),
    } as unknown as Stagehand;

    const healEvents: {
      stepIndex: number;
      technique: string;
      resolvedSelector: string | null;
      attempt: number;
    }[] = [];

    const outcome = await executeStepWithHealing({
      stagehand,
      page,
      step: OVERLAY_STEP,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 1,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      uploadFixture: null,
      isFinalStep: true,
      submitEndpointPattern: null,
      submittedStateSelectors: [],
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
      onStepHeal: (params: {
        stepIndex: number;
        technique: string;
        resolvedSelector: string | null;
        attempt: number;
      }) => {
        healEvents.push(params);
      },
    } as never);

    expect(outcome).toBe("completed");
    expect(realControlActivations).toBe(1);

    // The triager-facing artifact: exactly one heal event, on attempt 2, with
    // the same resolved xpath/selector `triedSelectors` would have carried
    // for a failed step's bundle — identifying the exact element the
    // fallback clicked without re-running the flow.
    expect(healEvents).toHaveLength(1);
    expect(healEvents[0]).toMatchObject({
      stepIndex: 0,
      attempt: 2,
      resolvedSelector: `xpath=${overlayXPath}`,
    });
    expect(typeof healEvents[0]?.technique).toBe("string");

    // Regression guard: onStepFailure's own shape and the existing
    // "healed on attempt" log line are unaffected by the new seam.
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt 2"))).toBe(
      true
    );
  });
});
