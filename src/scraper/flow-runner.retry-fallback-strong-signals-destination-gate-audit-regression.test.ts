import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression guard for the n+16 synthetic `el.click()` fallback's
 * `retryNetworkFired` / `checkboxStateVerified` / `retrySelectionStateChanged`
 * disjuncts (flow-runner.ts ~12829-12833).
 *
 * This subtask was seeded from an earlier recon snapshot that assumed these
 * three signals were exempt from `isPlausibleStepDestination`. That premise
 * is stale: commit 7e97d37 ("fix(scraper): gate retryNetworkFired/
 * checkboxStateVerified/retrySelectionStateChanged on destination
 * plausibility") already closed that gap, with its own full negative +
 * positive-control coverage in
 * flow-runner.retry-fallback-remaining-disjuncts-destination-audit.test.ts
 * (predates every test-NNN subtask in this run, including this one's
 * depends_on test-002/test-003). A step landing on a sign-in-shaped URL for
 * a step never about signing in does NOT get credited on any of these three
 * signals alone — asserting otherwise would encode disproven behavior.
 *
 * This file instead guards the inverse, real regression risk: a future
 * change accidentally REMOVING the `isPlausibleStepDestination` gate from
 * one of these three disjuncts. Each `it.each` case isolates exactly one
 * signal (all other disjuncts held false) landing on an implausible
 * (sign-in-shaped) destination for a step never about signing in, and
 * asserts the fallback is NOT credited — the gate must hold.
 *
 * Harness lifted from flow-runner.retry-fallback-remaining-disjuncts-
 * destination-audit.test.ts (per investigation_notes, itself derived from
 * flow-runner.n16-checkbox-xpath-retarget.test.ts's checkbox-step harness).
 * Site-agnostic fixture (generic "shop.example.com" checkout flow).
 */

const SIGNIN_URL = "https://shop.example.com/login";
const CONTINUE_STEP = "Confirm the shipping address and click continue to payment";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
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

function buildPage(
  bodyHtml: string,
  wireClick: (el: HappyDomElement) => void
): { page: Page; stagehand: Stagehand; getClickActivations: () => number } {
  const window = new Window({ url: SIGNIN_URL });
  const document = window.document;
  document.body.innerHTML = bodyHtml;

  const targetEl = document.getElementById("target") as unknown as HappyDomElement;
  expect(targetEl).not.toBeNull();
  const xpath = absoluteXPathFor(targetEl);

  // happy-dom has no real layout engine — stub a non-zero rect so the
  // selection-state baseline capture's `visible()` gate does not exclude
  // every candidate (a real production concern, not a mock).
  for (const el of Array.from(document.querySelectorAll("*"))) {
    (el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({
      width: 10,
      height: 10,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10,
      bottom: 10,
    });
  }

  let clickActivations = 0;
  (
    targetEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    wireClick(targetEl);
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
    url: () => SIGNIN_URL,
    title: async () => "Sign In",
    // Forces attemptN16TrustedClick down its outer catch and into the
    // synthetic el.click() fallback.
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
      actions: [{ selector: `xpath=${xpath}`, description: "Continue", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand, getClickActivations: () => clickActivations };
}

async function runStep(
  page: Page,
  stagehand: Stagehand,
  signalCounter: { n: number }
): Promise<{ attemptsByFailure: AttemptRecord[][]; threw: boolean }> {
  const attemptsByFailure: AttemptRecord[][] = [];
  let threw = false;
  try {
    await executeStepWithHealing({
      stagehand,
      page,
      step: CONTINUE_STEP,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 1,
      phase: "flow",
      signalCounter,
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
      onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
        attemptsByFailure.push(attempts);
        return null;
      },
    } as never);
  } catch {
    threw = true;
  }
  return { attemptsByFailure, threw };
}

describe("flow-runner n+16 fallback — strong-signal disjuncts stay gated by destination plausibility", () => {
  it.each([
    {
      label: "retryNetworkFired",
      verifiedByLabel: "network",
      bodyHtml: `<div class="checkoutFooter"><a id="target" href="#">Continue</a></div>`,
      wireClick: (_el: HappyDomElement, signalCounter: { n: number }) => {
        signalCounter.n += 1;
      },
    },
    {
      label: "checkboxStateVerified",
      verifiedByLabel: "dom",
      bodyHtml: `<div class="checkoutFooter"><input type="checkbox" id="target" /></div>`,
      wireClick: () => {},
    },
    {
      label: "retrySelectionStateChanged",
      verifiedByLabel: "dom",
      bodyHtml: `<div class="checkoutFooter"><div id="target" role="option" aria-selected="false">Ground shipping</div></div>`,
      wireClick: (el: HappyDomElement) => {
        (el as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute(
          "aria-selected",
          "true"
        );
      },
    },
  ])(
    "does NOT credit the fallback on $label alone when the landed page is sign-in-shaped and the step was never about signing in",
    async ({ verifiedByLabel, bodyHtml, wireClick }) => {
      const signalCounter = { n: 0 };
      const { page, stagehand, getClickActivations } = buildPage(bodyHtml, (el) =>
        wireClick(el, signalCounter)
      );

      const { attemptsByFailure, threw } = await runStep(page, stagehand, signalCounter);

      expect(getClickActivations()).toBeGreaterThan(0);
      expect(threw).toBe(true);
      expect(attemptsByFailure.length).toBeGreaterThan(0);
      for (const attempt of attemptsByFailure[0] ?? []) {
        expect(attempt.verifiedBy).not.toBe(verifiedByLabel);
      }
    }
  );
});
