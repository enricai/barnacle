import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the `onStepHeal` persistence seam (added for bugfix-003) on its OTHER
 * "completed" return point: the top-window `trusted-click-retry` path (attempt
 * 1 phantom-clicks a non-submit control, attempt 2 re-clicks the SAME resolved
 * target with a trusted gesture), not the n+16 fallback the sibling acceptance
 * test (flow-runner.healed-step-selector-persistence-acceptance.test.ts)
 * already covers. Both sites feed `onStepHeal` — the caller-visible artifact
 * that mirrors how `triedSelectors` already survives into a FAILED step's
 * `onStepFailure` dump — so a triager can tell which element a healed step
 * targeted without re-running the flow, regardless of which technique healed
 * it. Site-agnostic fixture (a generic careers-application overlay button),
 * not any real site or plugin.
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

describe("flow-runner onStepHeal — persists the resolved target for a trusted-click-retry heal (offline fixture, live happy-dom, no network)", () => {
  it("invokes onStepHeal with the same selector triedSelectors recorded, when a non-submit step verifies on attempt 2 via trusted-click-retry", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="wizardFooter">
        <div id="control" role="button" tabindex="0"></div>
      </div>
    `;

    const controlEl = document.getElementById("control") as unknown as HappyDomElement;
    expect(controlEl).not.toBeNull();

    const controlXPath = absoluteXPathFor(controlEl);
    const controlSelector = `xpath=${controlXPath}`;

    // Attempt 1's Stagehand `act()` never touches the DOM (mocked, like every
    // other offline acceptance fixture in this suite) — so attempt 1 reports
    // success but pre/post shows zero effect, classifying "phantom" and
    // escalating attempt 2 to `trusted-click-retry`. Only a REAL, trusted
    // `.locator().first().click()` (the primitive `trusted-click-retry`
    // re-clicks attempt 1's resolved xpath with) produces the large DOM
    // mutation below.
    let realActivations = 0;
    (
      controlEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      realActivations += 1;
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

    // The n+16 el.click() fallback runs on EVERY attempt whose primary
    // verification hasn't already passed — including attempt 1, on the SAME
    // top-window `.locator().first().click()` primitive `trusted-click-retry`
    // reuses at attempt 2. To force this fixture through attempt 2's
    // `trusted-click-retry` branch specifically (rather than healing via n+16
    // already at attempt 1), the FIRST click delivery is a no-op (the click
    // lands but doesn't register, as if the control were momentarily covered
    // by a transient overlay) — attempt 1 stays phantom (zero pre/post
    // effect) and escalates. The SECOND delivery — `trusted-click-retry`'s
    // own re-click of the SAME resolved xpath at attempt 2 — is real, and
    // its effect is what `verified` picks up BEFORE attempt 2 ever reaches
    // its own n+16 fallback gate (which only runs `if (!verified ...)`).
    let locatorClickCount = 0;
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
      locator: (selector: string) => ({
        first: () => ({
          click: async () => {
            expect(selector).toBe(controlSelector);
            locatorClickCount += 1;
            if (locatorClickCount === 1) return;
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
      // Attempt 1 reports success and resolves the target xpath, but the
      // mocked `act()` never touches the DOM — zero pre/post effect, so
      // `classifyPhantomClick` marks it "phantom" and escalates attempt 2 to
      // `trusted-click-retry` (non-submit step, no deepLocator frame seam).
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: OVERLAY_STEP,
        actions: [{ selector: controlSelector, description: "Continue", method: "click" }],
      }),
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          instruction === OVERLAY_STEP
            ? [{ selector: controlSelector, description: "Continue", method: "click" }]
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
      isFinalStep: false,
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
    expect(realActivations).toBe(1);

    // The triager-facing artifact: exactly one heal event, on attempt 2 via
    // `trusted-click-retry`, carrying the SAME selector `triedSelectors`
    // recorded for attempt 1's resolved target — the exact element the
    // trusted re-click actually targeted, without which nothing persists
    // which element a heal via this technique touched.
    expect(healEvents).toHaveLength(1);
    expect(healEvents[0]).toMatchObject({
      stepIndex: 0,
      attempt: 2,
      technique: "trusted-click-retry",
      resolvedSelector: controlSelector,
    });

    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt 2"))).toBe(
      true
    );
  });
});
