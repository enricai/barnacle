import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the n+16 synthetic `el.click()` fallback's
 * `weakDomSignalsAllowed` disjunct (flow-runner.ts's `retryVerified`
 * computation, ~12762-12790): a page-wide HTML/text/form-value delta alone
 * must not credit the fallback when the page never navigated away from a
 * sign-in-shaped URL for a step that was never about signing in — the same
 * `isPlausibleStepDestination` gate already computed two lines above (feeding
 * `classifyPhantomClick`'s `destinationPlausible`) must also gate this
 * disjunct. Distinct from
 * flow-runner.retry-fallback-destination-plausibility-veto-acceptance.test.ts,
 * which isolates `retryUrlChanged` alone (a genuine navigation to a
 * sign-in-shaped path); this test keeps `retryUrlChanged` false throughout
 * (the page starts and stays on a sign-in-shaped path) and instead mutates
 * the DOM — growing body HTML, changing visible text, and changing a form
 * input's value — so only the `weakDomSignalsAllowed` disjunct can credit
 * the click, reproducing the report's exact failing log shape (network=false
 * url=false htmlDelta>0 textChanged=true formValueChanged=true).
 * Site-agnostic fixture (generic "shop.example.com" checkout flow), not any
 * real site or plugin.
 */

const BASE_URL = "https://shop.example.com/login";
// Both phrasings contain "click the submit" so `isSubmitIntentStep` makes
// `retrySubmitShaped` true, which in turn makes `classifyPhantomClick`'s own
// `bytesChangedSignificantly`/`elementStateChanged` disjuncts (unrelated to
// this subtask's `weakDomSignalsAllowed` disjunct) stay vetoed — isolating
// `retryVerified` down to exactly the `weakDomSignalsAllowed` disjunct under
// test. Only the plausible phrasing's own action clause ("click sign in")
// matches `SIGN_IN_PATTERNS`.
const CONTINUE_STEP = "Click the submit button and click continue to confirm the shipping address";
const PLAUSIBLE_STEP = "Click the submit button and click sign in to confirm your identity";

const INFO_LINES: string[] = [];
const testLogger = {
  info: vi.fn((m: string) => INFO_LINES.push(m)),
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

function buildFixture(stepInstruction: string) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="loginFooter">
      <a id="continueLink" href="#">Go to payment</a>
      <input id="loginField" value="" />
    </div>
  `;

  const continueEl = document.getElementById("continueLink") as unknown as HappyDomElement;
  expect(continueEl).not.toBeNull();
  const continueXPath = absoluteXPathFor(continueEl);

  let clickActivations = 0;
  (
    continueEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    // No navigation at all — the URL stays on the sign-in-shaped path the
    // whole time (retryUrlChanged stays false). Only the DOM mutates: a
    // large HTML-byte growth, a visible-text change, and a form-value
    // change — the three `weakDomSignalsAllowed` disjunct signals.
    const loginField = document.getElementById("loginField") as unknown as {
      value: string;
    };
    loginField.value = "mutated-value";
    document.body.innerHTML += `<div id="grown">${"x".repeat(600)}</div>`;
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
    title: async () => "Sign In",
    // Forces attemptN16TrustedClick down its outer catch and into the
    // synthetic el.click() fallback — same precondition as
    // flow-runner.trusted-click-throw-wrong-destination-veto-acceptance.test.ts.
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
      actionDescription: stepInstruction,
      actions: [
        { selector: `xpath=${continueXPath}`, description: "Go to payment", method: "click" },
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

  return { page, stagehand, getClickActivations: () => clickActivations };
}

describe("flow-runner n+16 fallback — weakDomSignalsAllowed DOM delta on a sign-in-shaped page for a non-sign-in step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback as verified on DOM-delta alone when the landed page is sign-in-shaped and the step was never about signing in", async () => {
    const { page, stagehand, getClickActivations } = buildFixture(CONTINUE_STEP);
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing({
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
        onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      } as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    expect((attemptsByFailure[0] ?? []).length).toBeGreaterThan(0);

    // A page-wide HTML/text/form-value delta on a sign-in-shaped page must
    // not be silently credited verified via the DOM-delta disjunct alone —
    // on ANY attempt.
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the fallback as verified on the same DOM deltas when the landed page's sign-in shape matches a step that IS about signing in (positive control)", async () => {
    const { page, stagehand, getClickActivations } = buildFixture(PLAUSIBLE_STEP);
    const attemptsByFailure: AttemptRecord[][] = [];

    await executeStepWithHealing({
      stagehand,
      page,
      step: PLAUSIBLE_STEP,
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
      onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
        attemptsByFailure.push(attempts);
        return null;
      },
    } as never);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBe(0);
  });
});
