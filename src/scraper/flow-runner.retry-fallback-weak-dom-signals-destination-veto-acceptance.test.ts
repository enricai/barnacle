import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the n+16 synthetic `el.click()` fallback's weak
 * DOM-signal disjunct (`weakDomSignalsAllowed && (retryHtmlDelta !== 0 ||
 * retryTextChanged || retryFormValueChanged)` at flow-runner.ts ~12806-12808):
 * a sub-`TRIVIAL_DOM_DELTA_BYTES` html growth plus a visible-text change must
 * not credit the fallback when the click's genuine navigation lands on a
 * sign-in-shaped destination for a step that was never about signing in —
 * the same `isPlausibleStepDestination` gate
 * flow-runner.retry-fallback-destination-plausibility-veto-acceptance.test.ts
 * already proves for `retryUrlChanged`, applied here to the weak-signal
 * disjunct instead. `submitStep: false`, a non-final step, and a resolved
 * element whose accessible name doesn't clear the submit-shape bar keep
 * `retrySubmitShaped` false, so `weakDomSignalsAllowed` is true; the step
 * instruction is neither a checkbox/radio nor a selection-marker click, so
 * neither of those vetoes engages either — isolating `retryVerified` down to
 * exactly the weak-signal disjunct's own `retryDestinationPlausible` gate.
 * The html-byte delta is kept strictly below `TRIVIAL_DOM_DELTA_BYTES` (500B)
 * so `classifyPhantomClick`'s own `bytesChangedSignificantly` branch (and the
 * `retryUrlChanged` strong signal, which the sign-in-shaped destination
 * already makes implausible) cannot independently credit the step — isolating
 * the assertion to exactly the disjunct under test. A companion case keeps
 * the identical DOM-delta shape but navigates to a destination that is NOT
 * sign-in-shaped, asserting the step IS still credited — regression
 * protection for the legitimate non-submit DOM-delta credit path this
 * disjunct exists for. Site-agnostic fixture (generic "apply.example.com"
 * application flow), not any real site or plugin.
 */

const BASE_URL = "https://apply.example.com/application/experience";
const CONTINUE_STEP = "Continue to the next section of the application";

function makeLogger(lines: string[]): Logger {
  return {
    info: vi.fn((m: string) => lines.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
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

function buildHarness(destinationUrl: string, destinationTitle: string) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="applicationFooter">
      <a id="continueLink" href="/application/education">Go to education</a>
    </div>
  `;

  const continueEl = document.getElementById("continueLink") as unknown as HappyDomElement;
  expect(continueEl).not.toBeNull();
  const continueXPath = absoluteXPathFor(continueEl);

  let clickActivations = 0;
  let currentUrl = BASE_URL;
  let currentTitle = "Experience";
  (
    continueEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    // A genuine (but small, sub-500B) DOM growth plus a visible-text change —
    // the weak-signal shape the disjunct under test exists to credit — paired
    // with a real navigation so the destination-plausibility gate has
    // something to veto.
    document.body.innerHTML = `
      <div class="applicationFooter">
        <a id="continueLink" href="/application/education">Go to education</a>
      </div>
      <p>loading</p>
    `;
    currentUrl = destinationUrl;
    currentTitle = destinationTitle;
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
    url: () => currentUrl,
    title: async () => currentTitle,
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
      actions: [
        { selector: `xpath=${continueXPath}`, description: "Go to education", method: "click" },
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

describe("flow-runner n+16 fallback — weakDomSignalsAllowed disjunct bounces to a sign-in-shaped destination for a non-sign-in step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback as verified when its weak html/text-delta signal lands on a sign-in-shaped path for a step that was never about signing in", async () => {
    const { page, stagehand, getClickActivations } = buildHarness(
      "https://apply.example.com/login",
      "Sign In"
    );
    const infoLines: string[] = [];
    const logger = makeLogger(infoLines);
    const attemptsByFailure: AttemptRecord[][] = [];

    // `submitStep: false`, `isFinalStep: false`, and the resolved `<a>`'s
    // accessible name ("Go to education") not clearing the submit-shape
    // bar keep `retrySubmitShaped` false, so `weakDomSignalsAllowed` is true.
    // The step instruction is neither checkbox/radio-shaped nor a selection
    // marker, so neither of those vetoes engages — isolating `retryVerified`
    // down to the weak html/text-delta disjunct and its own
    // `retryDestinationPlausible` gate (the sign-in-shaped landing makes both
    // `retryUrlChanged` and `retryDestinationPlausible` false, so only this
    // gate decides the outcome).
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
        totalSteps: () => 3,
        phase: "flow",
        signalCounter: { n: 0 },
        recentCaptures: [],
        recentCaptureMeta: [],
        anthropic: null,
        rephraseModel: null,
        logger,
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

    // The fallback's weak html/text-delta signal was real, but it landed on
    // a sign-in-shaped destination for a step that was never about signing
    // in — must not be silently credited verified via the weak-signal
    // disjunct on ANY attempt.
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the fallback when the identical weak html/text-delta signal lands on a plausible (non-sign-in-shaped) destination", async () => {
    // Same URL/title as the pre-click baseline, so `retryUrlChanged` stays
    // false (no origin/path change) and crediting can only come from the
    // weak html/text-delta disjunct itself — isolating this regression case
    // to exactly the same signal the first case vetoes.
    const { page, stagehand, getClickActivations } = buildHarness(BASE_URL, "Experience");
    const infoLines: string[] = [];
    const logger = makeLogger(infoLines);

    const result = await executeStepWithHealing({
      stagehand,
      page,
      step: CONTINUE_STEP,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger,
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
      onStepFailure: () => null,
    } as never);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(result).toBeTruthy();
  });
});
