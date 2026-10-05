import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Audit coverage for the n+16 synthetic `el.click()` fallback's remaining
 * `retryVerified` disjuncts (flow-runner.ts ~12797-12808) that bugfix-001/002
 * did not touch: `retryNetworkFired`, `checkboxStateVerified`, and
 * `retrySelectionStateChanged`. The recon report's closing instruction asks
 * for EVERY disjunct in that boolean OR to be audited for the same
 * destination-plausibility gap `weakDomSignalsAllowed` had (bugfix-002), not
 * just the one named defect. Each `describe` block below lands its signal on
 * an implausible (sign-in-shaped) destination for a step that was never about
 * signing in, with every OTHER disjunct held false, isolating exactly one
 * signal at a time — then documents the actual, current disposition with a
 * positive control proving the isolation held.
 *
 * Findings:
 * - `retryNetworkFired` is a bare network-request COUNT with zero awareness
 *   of destination — gated here with the same `isPlausibleStepDestination`
 *   check `weakDomSignalsAllowed` already uses.
 * - `checkboxStateVerified` forces `.checked = true` on whatever element the
 *   xpath resolves to on the CURRENTLY LOADED page, independent of whether a
 *   click fallback navigated there correctly — gated for the same reason.
 * - `retrySelectionStateChanged` reads a fingerprint for whatever element the
 *   xpath/selector resolves to post-click, also independent of whether that
 *   page is the right destination — gated for the same reason.
 *
 * All three gates are symmetric with the existing `weakDomSignalsAllowed`
 * and `retryUrlChanged` gates: `isPlausibleStepDestination` only fires when
 * the landed URL is sign-in-shaped for a step that was never about signing
 * in, so an ordinary legitimate flow (which never bounces to a sign-in path)
 * is unaffected.
 *
 * Site-agnostic fixture (generic "shop.example.com" checkout flow), not any
 * real site or plugin.
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
): {
  page: Page;
  stagehand: Stagehand;
  xpath: string;
  getClickActivations: () => number;
} {
  const window = new Window({ url: SIGNIN_URL });
  const document = window.document;
  document.body.innerHTML = bodyHtml;

  const targetEl = document.getElementById("target") as unknown as HappyDomElement;
  expect(targetEl).not.toBeNull();
  const xpath = absoluteXPathFor(targetEl);

  // happy-dom has no real layout engine — stub a non-zero rect so the
  // selection-state baseline capture's `visible()` gate does not exclude
  // every candidate (a real production concern, not a mock); mirrors
  // flow-runner.class-marker-selection-verify.test.ts.
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

  return { page, stagehand, xpath, getClickActivations: () => clickActivations };
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

describe("flow-runner n+16 fallback — retryNetworkFired on a sign-in-shaped page for a non-sign-in step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback on a bare network-count bump alone when the landed page is sign-in-shaped and the step was never about signing in", async () => {
    const signalCounter = { n: 0 };
    const { page, stagehand, getClickActivations } = buildPage(
      `<div class="checkoutFooter"><a id="target" href="#">Continue</a></div>`,
      () => {
        // A background request fires (e.g. an analytics beacon) but the DOM
        // never changes and the URL never changes — isolates
        // `retryNetworkFired` as the only candidate disjunct.
        signalCounter.n += 1;
      }
    );

    const { attemptsByFailure, threw } = await runStep(page, stagehand, signalCounter);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(threw).toBe(true);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("network");
    }
  });

  it("still credits the fallback on the same network bump when the landed sign-in-shaped page matches a step that IS about signing in (positive control)", async () => {
    const signalCounter = { n: 0 };
    const signInStep = "Click continue and click sign in to confirm your identity";
    const { page, stagehand, getClickActivations } = buildPage(
      `<div class="checkoutFooter"><a id="target" href="#">Continue</a></div>`,
      () => {
        signalCounter.n += 1;
      }
    );
    stagehand.act = vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: signInStep,
      actions: [
        {
          selector: "xpath=/html[1]/body[1]/div[1]/a[1]",
          description: "Continue",
          method: "click",
        },
      ],
    });

    const attemptsByFailure: AttemptRecord[][] = [];
    await executeStepWithHealing({
      stagehand,
      page,
      step: signInStep,
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

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBe(0);
  });
});

describe("flow-runner n+16 fallback — checkboxStateVerified on a sign-in-shaped page for a non-sign-in, non-checkbox step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback on a forced checkbox check alone when the landed page is sign-in-shaped and the step was never about signing in or checkboxes", async () => {
    const signalCounter = { n: 0 };
    // The n+16 synthetic clickExpr forces `.checked = true` unconditionally
    // on whatever element the xpath resolves to when it's a checkbox input —
    // independent of the step's own intent and of whether this page is the
    // right destination. No ancestor ng-invalid marker, so
    // `ancestorStillInvalid` stays false and `checkboxStateVerified` alone is
    // the only candidate disjunct (no DOM delta, no network, no URL change).
    const { page, stagehand } = buildPage(
      `<div class="checkoutFooter"><input type="checkbox" id="target" /></div>`,
      () => {}
    );

    const { attemptsByFailure, threw } = await runStep(page, stagehand, signalCounter);

    expect(threw).toBe(true);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the fallback on the same forced checkbox check when the landed sign-in-shaped page matches a step that IS about signing in (positive control)", async () => {
    const signalCounter = { n: 0 };
    const signInStep = "Check the box and click sign in to confirm your identity";
    const { page, stagehand } = buildPage(
      `<div class="checkoutFooter"><input type="checkbox" id="target" /></div>`,
      () => {}
    );
    stagehand.act = vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: signInStep,
      actions: [
        {
          selector: "xpath=/html[1]/body[1]/div[1]/input[1]",
          description: "checkbox",
          method: "click",
        },
      ],
    });

    const attemptsByFailure: AttemptRecord[][] = [];
    await executeStepWithHealing({
      stagehand,
      page,
      step: signInStep,
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

    expect(attemptsByFailure.length).toBe(0);
  });
});

describe("flow-runner n+16 fallback — retrySelectionStateChanged on a sign-in-shaped page for a non-sign-in step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback on an element-scoped selection fingerprint change alone when the landed page is sign-in-shaped and the step was never about signing in", async () => {
    const signalCounter = { n: 0 };
    const { page, stagehand, getClickActivations } = buildPage(
      `<div class="checkoutFooter"><div id="target" role="option" aria-selected="false">Ground shipping</div></div>`,
      (el) => {
        // The option's own aria-selected flips on click — a genuine,
        // element-scoped commit, isolated from any DOM-wide delta, network,
        // or URL change.
        (el as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute(
          "aria-selected",
          "true"
        );
      }
    );

    const { attemptsByFailure, threw } = await runStep(page, stagehand, signalCounter);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(threw).toBe(true);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the fallback on the same selection-fingerprint change when the landed sign-in-shaped page matches a step that IS about signing in (positive control)", async () => {
    const signalCounter = { n: 0 };
    const signInStep = "Select the option and click sign in to confirm your identity";
    const { page, stagehand, xpath, getClickActivations } = buildPage(
      `<div class="checkoutFooter"><div id="target" role="option" aria-selected="false">Ground shipping</div></div>`,
      (el) => {
        (el as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute(
          "aria-selected",
          "true"
        );
      }
    );
    stagehand.act = vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: signInStep,
      actions: [
        { selector: `xpath=${xpath}`, description: "Ground shipping option", method: "click" },
      ],
    });

    const attemptsByFailure: AttemptRecord[][] = [];
    await executeStepWithHealing({
      stagehand,
      page,
      step: signInStep,
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

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBe(0);
  });
});
